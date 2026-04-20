import { GoogleGenAI } from "@google/genai";

let aiInstance: GoogleGenAI | null = null;

function getAI() {
  if (!aiInstance) {
    const apiKey = typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : undefined;
    if (!apiKey) {
      console.warn("GEMINI_API_KEY is not defined in the environment.");
    }
    aiInstance = new GoogleGenAI({ apiKey: apiKey || "" });
  }
  return aiInstance;
}

export async function translateText(
  text: string,
  sourceLangName: string,
  targetLangName: string,
  retries = 2
): Promise<string> {
  try {
    const ai = getAI();
    const isAuto = sourceLangName === 'Auto Detect';
    
    // Intelligent prompt for language detection and routing
    const prompt = isAuto 
      ? `You are a universal translator. 
         Task:
         1. Detect the language of the source text.
         2. If it is NOT ${targetLangName}, translate it to ${targetLangName}.
         3. If it matches ${targetLangName}, translate it to English (or if English, to Spanish).
         4. Output in this EXACT format: "[Detected: {DetectedLanguage}] (For {TargetUserLanguage} speaker): {Translation}"
         
         Source text: "${text}"`
      : `Direct ${sourceLangName} to ${targetLangName} translation. NO fluff or preamble: "${text}"`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt
    });

    return response.text?.trim() || "Translation failed.";
  } catch (error) {
    if (retries > 0) {
      console.warn(`Translation failed, retrying... (${retries} attempts left)`);
      // Short delay before retry
      await new Promise(resolve => setTimeout(resolve, 500));
      return translateText(text, sourceLangName, targetLangName, retries - 1);
    }
    throw error;
  }
}
