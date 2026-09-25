const Groq = require('groq-sdk');
const pdfParse = require('pdf-parse');

export const config = {
  api: { bodyParser: false }
};

async function parseBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sanitizeJson(raw) {
  let text = String(raw || '').trim();

  text = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*$/g, '')
    .replace(/^\s*```\s*/g, '')
    .trim();

  // remove trailing commas before closing brackets/objects
  text = text.replace(/,\s*([}\]])/g, '$1');

  return text;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const subject = req.headers['x-subject'] || 'General Knowledge';
    const language = req.headers['x-language'] || 'English';

    const buffer = await parseBuffer(req);

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'No PDF file uploaded.' });
    }

    const pdfData = await pdfParse(buffer);
    const extractedText = (pdfData.text || '').slice(0, 30000);

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const prompt = `
    You are an expert examiner for the subject: ${subject}.
    Analyze the following document text:

    ${extractedText}

    Task:
    Generate 10 original multiple-choice questions (MCQs) in ${language}.

    Return ONLY a valid raw JSON array with no markdown fences, no commentary, and no extra text.

    Schema:
    [
      {
        "question": "Question text in ${language}",
        "options": ["Option A", "Option B", "Option C", "Option D"],
        "answerIndex": 0,
        "explanation": "Brief explanation in ${language}"
      }
    ]
    `;

    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      temperature: 0.2
    });

    const responseText = completion.choices[0]?.message?.content || '[]';
    const jsonString = sanitizeJson(responseText);

    let quizQuestions = JSON.parse(jsonString);

    if (!Array.isArray(quizQuestions)) {
      if (Array.isArray(quizQuestions?.questions)) quizQuestions = quizQuestions.questions;
      else if (Array.isArray(quizQuestions?.data)) quizQuestions = quizQuestions.data;
      else throw new Error('Model returned a non-array payload.');
    }

    return res.status(200).json({ success: true, questions: quizQuestions });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
