const translationCache = new Map();
const resourceRoot = new URL(".", import.meta.url);

export function homeAssistantLanguage(hass) {
  return hass?.language || hass?.locale?.language || navigator.language || "en";
}

export async function loadGuardianEyeTranslations(language) {
  const candidates = localeCandidates(language);
  for (const candidate of candidates) {
    if (!translationCache.has(candidate)) {
      translationCache.set(candidate, fetchLocale(candidate));
    }
    const translations = await translationCache.get(candidate);
    if (translations) {
      return translations;
    }
  }
  return {};
}

export function translate(translations, key, fallback) {
  const value = translations?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function localeCandidates(language) {
  const normalized = String(language || "en").replaceAll("_", "-");
  const lower = normalized.toLowerCase();
  const candidates = [];

  if (lower.startsWith("zh")) {
    candidates.push(
      lower.includes("hant") || lower.endsWith("-tw") || lower.endsWith("-hk")
        ? "zh-Hant"
        : "zh",
    );
  } else if (lower === "pt-br") {
    candidates.push("pt-BR");
  } else {
    candidates.push(normalized, normalized.split("-")[0]);
  }
  candidates.push("en");
  return [...new Set(candidates)];
}

async function fetchLocale(locale) {
  try {
    const url = new URL(
      `guardian-eye-locales/Strings.${locale}.json?v=1.0.5`,
      resourceRoot,
    );
    const response = await fetch(url, { cache: "force-cache" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
