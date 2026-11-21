const COUNTRIES = new Set(["Togo", "Bénin", "Côte d’Ivoire", "Burkina Faso", "Sénégal", "Mali", "Niger"]);

type ClerkRegistrationUser = {
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: { emailAddress: string; verification: { status: string } | null } | null;
  unsafeMetadata: Record<string, unknown>;
};

function optionalText(value: unknown, maximum: number) {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new Error("INVALID_REGISTRATION_PROFILE");
  }
  return value.trim();
}

// Metadata is user-editable: read only profile fields, never roles or KYC status.
export function registrationProfileFromClerk(user: ClerkRegistrationUser) {
  const email = user.primaryEmailAddress;
  if (!email || email.verification?.status !== "verified") {
    throw new Error("VERIFIED_EMAIL_REQUIRED");
  }
  const metadata = user.unsafeMetadata;
  const country = optionalText(metadata.country, 80) ?? "Togo";
  if (!COUNTRIES.has(country)) throw new Error("INVALID_REGISTRATION_COUNTRY");
  return {
    firstName: optionalText(metadata.firstName, 80) ?? optionalText(user.firstName, 80) ?? "Utilisateur",
    lastName: optionalText(metadata.lastName, 80) ?? optionalText(user.lastName, 80) ?? "Mulapay",
    email: email.emailAddress,
    phone: optionalText(metadata.phone, 30) ?? null,
    country,
  };
}
