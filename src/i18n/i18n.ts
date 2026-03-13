// src/i18n/i18n.ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import * as SDK from "azure-devops-extension-sdk";

import en from "../i18n/locales/en/translation.json";
import fr from "../i18n/locales/fr/translation.json";

// --- Détecteur personnalisé "devops" ---
// i18next-browser-languagedetector attend: { name, lookup(options), cacheUserLanguage(...) }
const devopsDetector = {
  name: "devops",
  lookup() {
    try {
      const page: any = SDK.getPageContext?.();
      const candidate =
        page?.webContext?.user?.culture ||
        page?.globalization?.culture ||
        undefined;
      if (typeof candidate === "string" && candidate) return candidate;
    } catch {
      /* ignore */
    }
    return undefined;
  },
  cacheUserLanguage() {
    /* no-op */
  }
};

// --- Enregistrer notre détecteur custom sur une instance de detector ---
const detector = new LanguageDetector();
detector.addDetector(devopsDetector as any);

// --- Initialiser i18next avec notre detector + react-i18next ---
i18n
  .use(detector)            // ⬅️ instance qui contient "devops"
  .use(initReactI18next)
  .init({
    // active "debug: true" au besoin pour voir les logs de détection
    debug: true,

    fallbackLng: "en",
    supportedLngs: ["en", "fr"],

    resources: {
      en: { translation: en },
      fr: { translation: fr }
    },
    react: {
      useSuspense: false
    },
    detection: {
      order: ["devops", "navigator", "htmlTag", "querystring", "localStorage"],
      caches: ["localStorage"]
    },

    interpolation: { escapeValue: false }
  });

export default i18n;