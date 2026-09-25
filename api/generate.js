const { GoogleGenAI } = require('@google/genai');
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

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const prompt = `
    You are an expert examiner for the subject: ${subject}.
    Analyze the following text extracted from a PDF document:

    ${extractedText}

    Tasks:
    1. Create 10 original multiple-choice questions (MCQs) focusing on ${subject}.
    2. Write all questions, options, and explanations in ${language}.

    Return strictly a raw JSON array adhering to this schema:
    [
      {
        "question": "Question text in ${language}",
        "options": ["Option A", "Option B", "Option C", "Option D"],
        "answerIndex": 0,
        "explanation": "Brief explanation in ${language}"
      }
    ]
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' }
    });

    const quizQuestions = JSON.parse(response.text);
    return res.status(200).json({ success: true, questions: quizQuestions });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
