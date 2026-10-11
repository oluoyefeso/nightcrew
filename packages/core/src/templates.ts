import { type TaskPolicies, validatePolicies } from "./policy";

export interface PortablePolicyTemplate {
  format: "nightcrew.verification-template";
  version: 1;
  name: string;
  policies: TaskPolicies;
}

export function validateTemplateName(name: unknown): string | null {
  return typeof name !== "string" || !name.trim() || name.length > 100
    ? "Name the template (up to 100 characters)."
    : null;
}

export function validatePortableTemplate(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Choose a NightCrew verification template JSON file.";
  const row = value as PortablePolicyTemplate;
  if (row.format !== "nightcrew.verification-template" || row.version !== 1)
    return "This template format or version is not supported.";
  if (Object.keys(row).some((key) => !["format", "version", "name", "policies"].includes(key)))
    return "A portable template may contain only its format, version, name and task policies.";
  return validateTemplateName(row.name) ?? validatePolicies(row.policies);
}

export function portableTemplate(name: string, policies: TaskPolicies): PortablePolicyTemplate {
  return { format: "nightcrew.verification-template", version: 1, name: name.trim(), policies };
}
