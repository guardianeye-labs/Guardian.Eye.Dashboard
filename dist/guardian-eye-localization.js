const translationCache = new Map();
const resourceRoot = new URL(".", import.meta.url);
const recordingModeTranslations = {
  OFF: ["RecordingOff", "Off"],
  ALWAYS: ["RecordingAlways", "Always"],
  MOTION: ["RecordingOnMotion", "On motion"],
  AI: ["RecordingOnAI", "AI only"],
  ONVIF: ["RecordingOnONVIF", "Camera events"],
};

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

export function localizeRecordingMode(translations, mode) {
  const canonical = String(mode ?? "").toUpperCase();
  const definition = recordingModeTranslations[canonical];
  return definition
    ? translate(translations, definition[0], definition[1])
    : mode;
}

export function localizeRecordingModeHass(hass, entityId, translations) {
  const entity = hass?.states?.[entityId];
  if (!entity) {
    return hass;
  }

  const options = Array.isArray(entity.attributes?.options)
    ? entity.attributes.options
    : [];
  const canonicalByLabel = new Map(options.map((option) => [
    localizeRecordingMode(translations, option),
    option,
  ]));
  const localizedEntity = {
    ...entity,
    state: localizeRecordingMode(translations, entity.state),
    attributes: {
      ...entity.attributes,
      options: options.map((option) => localizeRecordingMode(translations, option)),
    },
  };

  return {
    ...hass,
    states: { ...hass.states, [entityId]: localizedEntity },
    callService(domain, service, serviceData, target) {
      const data = domain === "select" && service === "select_option"
        && canonicalByLabel.has(serviceData?.option)
        ? { ...serviceData, option: canonicalByLabel.get(serviceData.option) }
        : serviceData;
      return hass.callService(domain, service, data, target);
    },
  };
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
      `guardian-eye-locales/Strings.${locale}.json?v=1.0.9`,
      resourceRoot,
    );
    const response = await fetch(url, { cache: "force-cache" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
