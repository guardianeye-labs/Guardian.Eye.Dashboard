import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { localizeAiDetectionHass, syncGuardianEyeLanguage } from "../dist/guardian-eye-localization.js";

test("all 18 locales contain every dashboard label and preserve placeholders", async () => {
  const root = new URL("../", import.meta.url);
  const keys = JSON.parse(await readFile(new URL("locale-keys.json", root)));
  const en = JSON.parse(await readFile(new URL("dist/guardian-eye-locales/Strings.en.json", root)));
  const files = await readdir(new URL("dist/guardian-eye-locales/", root));
  assert.equal(files.length, 18);
  for (const file of files) {
    const data = JSON.parse(await readFile(new URL(`dist/guardian-eye-locales/${file}`, root)));
    for (const key of keys) {
      assert.equal(typeof data[key], "string", `${file}: ${key}`);
      assert.ok(data[key].trim(), `${file}: ${key}`);
      assert.deepEqual(data[key].match(/\{\d+\}/g), en[key].match(/\{\d+\}/g), `${file}: ${key}`);
    }
    assert.notEqual(data.HALiveStatus, data.HALiveVideo);
  }
});

test("object text is translated for display without changing automation state", () => {
  const hass = { states: { "sensor.renamed_ai": { state: "Chair", attributes: { confidence: 0.9 } } } };
  const result = localizeAiDetectionHass(hass, "sensor.renamed_ai", { AIChair: "Стул" });
  assert.equal(result.states["sensor.renamed_ai"].state, "Стул");
  assert.equal(hass.states["sensor.renamed_ai"].state, "Chair");
  assert.equal(localizeAiDetectionHass(hass, "sensor.missing", {}), hass);
});

test("profile language is sent once per owner connection and follows HA language changes", async () => {
  const sent = [];
  const connection = {};
  const hass = { connection, language: "ru", user: { is_owner: true }, callWS: async data => sent.push(data) };
  syncGuardianEyeLanguage(hass);
  syncGuardianEyeLanguage({ ...hass });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [{ type: "guardian_eye/frontend_language", language: "ru" }]);
  syncGuardianEyeLanguage({ ...hass, language: "de" });
  syncGuardianEyeLanguage({ ...hass, language: "fr", user: { is_owner: false } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent[1], { type: "guardian_eye/frontend_language", language: "de" });
  assert.equal(sent.length, 2);
});
