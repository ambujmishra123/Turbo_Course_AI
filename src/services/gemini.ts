import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;
    console.warn(`Gemini API call failed, retrying... (${retries} left)`, error);
    await new Promise(resolve => setTimeout(resolve, delay));
    return withRetry(fn, retries - 1, delay * 1.5);
  }
}

export interface CourseTopic {
  title: string;
  description: string;
  searchQuery: string;
  videoUrl?: string;
  videoTitle?: string;
  videoSummary?: string;
  completed?: boolean;
}

export interface Course {
  title: string;
  introduction: string;
  topics: CourseTopic[];
}

export async function generateCourseStructure(params: {
  subject: string;
  goal: string;
  timeCommitment: string;
  level: string;
}): Promise<Course> {
  return withRetry(async () => {
    // Determine number of topics based on time commitment
    let topicCount = 5;
    if (params.timeCommitment.includes("1 hour")) topicCount = 3;
    else if (params.timeCommitment.includes("10 hours")) topicCount = 7;
    else if (params.timeCommitment.includes("20+ hours")) topicCount = 10;

    const prompt = `Create a detailed course structure for learning "${params.subject}".
    Goal: ${params.goal}
    Time Commitment: ${params.timeCommitment}
    Level: ${params.level}
    Number of Topics: Exactly ${topicCount} topics.

    Provide a course title, a comprehensive introduction (in Markdown), and a list of exactly ${topicCount} topics.
    For each topic, provide a title, a brief description of what will be covered, and a specific, high-quality YouTube search query that would find a RECENT, POPULAR, and HIGH-QUALITY educational video for this topic.
    
    IMPORTANT: 
    1. Strictly respect the time commitment of ${params.timeCommitment}. 
    2. For a 1-hour course, keep it very high-level and concise with exactly ${topicCount} topics. Each topic should ideally correspond to a video of about 15-20 minutes.
    3. All content must be in English.
    4. Ensure topics are logically ordered.
    5. The total duration of all suggested videos MUST NOT exceed ${params.timeCommitment}.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            introduction: { type: Type.STRING },
            topics: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  searchQuery: { type: Type.STRING },
                },
                required: ["title", "description", "searchQuery"],
              },
            },
          },
          required: ["title", "introduction", "topics"],
        },
      },
    });

    if (!response.text) throw new Error("Empty response from Gemini");
    return JSON.parse(response.text);
  });
}

export async function checkVideoAvailability(url: string): Promise<boolean> {
  try {
    const videoIdMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) return false;
    const videoId = videoIdMatch[1];
    
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // YouTube returns a 120x90 placeholder for mqdefault.jpg if video is missing
        if (img.width === 120 && img.height === 90) {
          resolve(false);
        } else {
          resolve(true);
        }
      };
      img.onerror = () => resolve(false);
      // mqdefault is reliable for existence check
      img.src = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    });
  } catch (e) {
    return false;
  }
}

export async function findVideoForTopic(topic: CourseTopic): Promise<{ url: string; title: string }> {
  return withRetry(async () => {
    const prompt = `Find a high-quality, CURRENTLY AVAILABLE, and educational YouTube video for the topic: "${topic.title}". 
    Topic Description: ${topic.description}
    Search query: ${topic.searchQuery}
    
    CRITICAL REQUIREMENTS:
    1. The video MUST be in ENGLISH.
    2. The video MUST be a REAL, WORKING YouTube video URL (format: https://www.youtube.com/watch?v=VIDEO_ID).
    3. DO NOT hallucinate a URL. Only provide a URL that actually exists on YouTube.
    4. Prefer videos from reputable educational channels (e.g., CrashCourse, Khan Academy, MIT OpenCourseWare, TED-Ed, Veritasium, 3Blue1Brown, etc.).
    5. Ensure the video is still available and not a "Video unavailable" placeholder.
    6. Avoid playlists, live streams, or non-educational content.
    
    Return ONLY the URL and the exact title of the video.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    let url = "";
    let title = topic.title;

    // 1. Check grounding chunks first (most reliable for URLs)
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (chunks) {
      // Look for any chunk that contains a youtube watch link
      const youtubeChunk = chunks.find(c => c.web?.uri?.includes("youtube.com/watch?v="));
      if (youtubeChunk?.web) {
        url = youtubeChunk.web.uri;
        title = youtubeChunk.web.title || title;
      }
    }

    // 2. Fallback to regex on the text response if grounding didn't yield a URL
    if (!url) {
      const text = response.text || "";
      // Match standard youtube watch URLs
      const youtubeRegex = /(https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11})/;
      const match = text.match(youtubeRegex);
      if (match) {
        url = match[0];
      }
    }

    // 3. Final validation: Ensure it's a valid-looking YouTube URL and not a generic search link
    if (!url || !url.includes("v=") || url.includes("search?")) {
      throw new Error(`Could not find a valid YouTube video for: ${topic.title}. The search result was invalid.`);
    }

    return { url, title };
  });
}

export async function summarizeVideo(videoUrl: string, topicTitle: string): Promise<string> {
  return withRetry(async () => {
    const prompt = `I have found a YouTube video for the topic "${topicTitle}" at ${videoUrl}.
    Please use Google Search to find information about this specific video's content and provide a 2-3 sentence summary of what it teaches. 
    Focus on the educational value for a student.
    
    IMPORTANT: 
    1. Use standard Markdown for formatting (e.g., **bold** for emphasis).
    2. Do NOT escape markdown characters.
    3. Return ONLY the summary text.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    return response.text || "Summary not available.";
  });
}

export async function regenerateCourseStructure(
  params: {
    subject: string;
    goal: string;
    timeCommitment: string;
    level: string;
  },
  currentCourse: Course,
  feedback: string
): Promise<Course> {
  return withRetry(async () => {
    let topicCount = currentCourse.topics.length;

    const prompt = `You previously generated a course structure for "${params.subject}".
    Goal: ${params.goal}
    Time Commitment: ${params.timeCommitment}
    Level: ${params.level}
    
    Current Course Structure:
    Title: ${currentCourse.title}
    Topics: ${currentCourse.topics.map(t => t.title).join(", ")}

    The user has the following feedback/changes: "${feedback}"

    Please regenerate the course structure (title, introduction, and topics) incorporating this feedback.
    Maintain exactly ${topicCount} topics unless the user specifically asks for more or fewer.
    
    IMPORTANT:
    1. Strictly respect the time commitment of ${params.timeCommitment}.
    2. All content must be in English.
    3. Ensure topics are logically ordered.
    4. For each topic, provide a title, description, and high-quality YouTube search query.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            introduction: { type: Type.STRING },
            topics: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  searchQuery: { type: Type.STRING },
                },
                required: ["title", "description", "searchQuery"],
              },
            },
          },
          required: ["title", "introduction", "topics"],
        },
      },
    });

    if (!response.text) throw new Error("Empty response from Gemini");
    return JSON.parse(response.text);
  });
}
