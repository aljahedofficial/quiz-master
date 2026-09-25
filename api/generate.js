const Groq = require('groq-sdk');
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

// Active supported Groq models with robust fallbacks
const CANDIDATE_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'llama3-70b-8192'
];

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

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const systemPrompt = `You are a strict examination system. Respond ONLY with a valid JSON array. No conversational text, no markdown formatting.`;
    
    const userPrompt = `
    Subject: ${subject}
    Language: ${language}
    Document Text:
    ${extractedText}

    Instructions:
    1. Generate 10 original multiple-choice questions (MCQs) in ${language}.
    2. Output strictly a JSON array formatted like this:
    [
      {
        "question": "Question text",
        "options": ["Option A", "Option B", "Option C", "Option D"],
        "answerIndex": 0,
        "explanation": "Brief explanation"
      }
    ]
    `;

    let responseText = null;
    let lastError = null;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const completion = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          model: modelName,
          temperature: 0.2
        });

        responseText = completion.choices[0]?.message?.content;
        if (responseText) break;
      } catch (err) {
        console.warn(`Model ${modelName} failed:`, err.message);
        lastError = err;
      }
    }

    if (!responseText) {
      throw lastError || new Error("Failed to generate quiz from Groq API.");
    }

    // Sanitize any accidental code-block markdown wrappers
    const jsonString = responseText.replace(/```json|```/g, '').trim();
    let quizQuestions = JSON.parse(jsonString);

    if (!Array.isArray(quizQuestions)) {
      if (quizQuestions.questions) quizQuestions = quizQuestions.questions;
      else if (quizQuestions.data) quizQuestions = quizQuestions.data;
    }

    return res.status(200).json({ success: true, questions: quizQuestions });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
