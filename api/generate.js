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

    const prompt = `
    You are an expert examiner for: ${subject}.
    Analyze this text:
    ${extractedText}

    Task:
    Create 10 multiple-choice questions (MCQs) in ${language}.
    
    Output Format:
    Return ONLY a single valid JSON array with 10 question objects. Do not wrap in key names like "questions" or use codeblocks.
    
    JSON Schema:
    [
      {
        "question": "Question string",
        "options": ["Opt A", "Opt B", "Opt C", "Opt D"],
        "answerIndex": 0,
        "explanation": "Brief explanation string"
      }
    ]
    `;

    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      temperature: 0.2
    });

    const responseText = completion.choices[0]?.message?.content || '[]';
    
    // Clean potential markdown quotes/code block formatting safely
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
