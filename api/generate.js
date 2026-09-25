const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');

export const config = {
  api: { bodyParser: false }
};

async function parseBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Fallback sequence if a model hits 503 high-demand
const CANDIDATE_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const subject = req.headers['x-subject'] || 'General Knowledge';
    const language = req.headers['x-language'] || 'English';

    const buffer = await parseBuffer(req);
    const pdfData = await pdfParse(buffer);
    const extractedText = pdfData.text.slice(0, 30000);

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const prompt = `
    You are an expert examiner specializing in ${subject}.
    Analyze the following text extracted from a PDF document:

    ${extractedText}

    Tasks:
    1. Create 10 original multiple-choice questions (MCQs) focusing on ${subject}.
    2. Write all questions, options, and explanations in ${language}.

    Return strictly a raw JSON array adhering to this structure:
    [
      {
        "question": "Question text in ${language}",
        "options": ["Option A", "Option B", "Option C", "Option D"],
        "answerIndex": 0,
        "explanation": "Brief explanation in ${language}"
      }
    ]
    `;

    let responseText = null;
    let lastError = null;

    // Loop through candidate models until one succeeds
    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { responseMimeType: 'application/json' }
        });

        const result = await model.generateContent(prompt);
        responseText = result.response.text();
        if (responseText) break; // Request succeeded!
      } catch (err) {
        console.warn(`Model ${modelName} failed or overloaded. Trying fallback...`, err.message);
        lastError = err;
      }
    }

    if (!responseText) {
      throw lastError || new Error("All AI models are currently saturated. Please try again shortly.");
    }

    const quizQuestions = JSON.parse(responseText);
    return res.status(200).json({ success: true, questions: quizQuestions });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
