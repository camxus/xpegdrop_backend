// services/email/renderTemplate.ts
export function renderTemplate(
  html: string,
  variables: Record<string, string>
) {
  return Object.entries(variables).reduce(
    (acc, [key, value]) =>
      acc.replace(new RegExp(`{{${key}}}`, "g"), value),
    html
  );
}
