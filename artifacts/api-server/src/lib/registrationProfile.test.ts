import assert from "node:assert/strict";
import { test } from "node:test";
import { registrationProfileFromClerk } from "./registrationProfile";

const verifiedEmail = { emailAddress: "registration@example.com", verification: { status: "verified" } };

test("keeps registration fields from metadata when Clerk name fields are disabled", () => {
  const profile = registrationProfileFromClerk({
    firstName: null,
    lastName: null,
    primaryEmailAddress: verifiedEmail,
    unsafeMetadata: { firstName: "  Test  ", lastName: " Inscription ", phone: " 71900000 ", country: "Bénin", role: "SUPER_ADMIN", kycStatus: "VERIFIE" },
  });
  assert.deepEqual(profile, {
    firstName: "Test", lastName: "Inscription", email: "registration@example.com",
    phone: "71900000", country: "Bénin",
  });
  assert.ok(!("role" in profile));
  assert.ok(!("kycStatus" in profile));
});

test("accepts Clerk profile fields for accounts without registration metadata", () => {
  assert.deepEqual(registrationProfileFromClerk({
    firstName: "Test", lastName: "Compte", primaryEmailAddress: verifiedEmail, unsafeMetadata: {},
  }), {
    firstName: "Test", lastName: "Compte", email: "registration@example.com", phone: null, country: "Togo",
  });
});

test("rejects unverified email addresses", () => {
  assert.throws(() => registrationProfileFromClerk({
    firstName: "Test", lastName: "Compte", unsafeMetadata: {},
    primaryEmailAddress: { ...verifiedEmail, verification: { status: "unverified" } },
  }), /VERIFIED_EMAIL_REQUIRED/);
});

test("rejects unsupported countries and malformed profile metadata", () => {
  const base = { firstName: null, lastName: null, primaryEmailAddress: verifiedEmail };
  for (const unsafeMetadata of [{ country: "Other" }, { firstName: 123 }, { lastName: " " }, { phone: "1".repeat(31) }]) {
    assert.throws(() => registrationProfileFromClerk({ ...base, unsafeMetadata }), /INVALID_REGISTRATION/);
  }
});
