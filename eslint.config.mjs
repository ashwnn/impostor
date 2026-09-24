import { plugin as shadcn } from "@shadcn/lint";
import tsParser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: ["dist/**", "node_modules/**", "data/**", "site/**"],
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: { shadcn },
    rules: {
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-raw-colors": "error",
      "shadcn/no-inline-styles": "error",
      "shadcn/no-unknown-classes": "error",
      "shadcn/require-static-classes": "error",
      "shadcn/no-restyle": [
        "error",
        {
          allow: ["layout"],
          contracts: [
            {
              pattern: "^Button$",
              allow: ["layout"],
              deny: ["p-*", "rounded-full"],
            },
            {
              pattern: "^Card$",
              allow: ["layout", "spacing", "color", "shape", "effects"],
              deny: ["font-*", "text-*"],
            },
            { pattern: "^CardHeader$", allow: ["layout", "spacing"] },
            { pattern: "^CardContent$", allow: ["layout", "spacing", "color"] },
            { pattern: "^CardTitle$", allow: ["layout", "typography", "color"] },
            { pattern: "^Badge$", allow: ["layout", "spacing", "typography"] },
            { pattern: "^Input$", allow: ["layout", "typography"] },
            { pattern: "^Textarea$", allow: ["layout", "typography"] },
            { pattern: "^Label$", allow: ["layout", "typography"] },
          ],
        },
      ],
    },
  },
  {
    // The design system itself styles these components.
    files: ["app/components/ui/**/*.{ts,tsx}"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/require-static-classes": "off",
    },
  },
  {
    // Game components and screens may use the app's custom layout utilities.
    files: ["app/screens/**/*.{ts,tsx}", "app/components/game/**/*.{ts,tsx}", "app/App.tsx"],
    rules: {
      "shadcn/no-unknown-classes": [
        "error",
        {
          allow: [
            "app-shell",
            "display",
            "reveal-in",
            "stagger",
            "accent-signal",
            "touch-manipulation",
          ],
        },
      ],
    },
  },
]);
