// Turning whatever an upstream system sends as a phone number into the one form
// WhatsApp needs: the full international number (country code first, digits only).
//
//   "+1 (857) 707-5969"  "+55 11 99977-7057"   explicit country code — trusted
//   "0055 11 99977 7057"                       00 is the international prefix — same
//   "5511999777057"      "18577075969"         already includes its country code
//   "(857) 707-5969"     "11 99977-7057"       national — needs a country code from
//                                              the request, or the account's own country
//
// Gakai never guesses: a number it cannot place confidently is refused, because the
// alternative is a message delivered to the wrong person.
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';

const CALLING_CODES = new Set(getCountries().map(country => getCountryCallingCode(country)));
const REGIONS = new Set(getCountries());

// "55", "+55", "1", or a region such as "BR" / "us" -> a calling code, or null.
export function resolveCallingCode(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\+?\d{1,3}$/.test(text)) {
    const code = text.replace('+', '');
    return CALLING_CODES.has(code) ? code : null;
  }
  const region = text.toUpperCase();
  return /^[A-Z]{2}$/.test(region) && REGIONS.has(region) ? getCountryCallingCode(region) : null;
}

// The country calling code of a full number (digits), e.g. the connected account's own.
export function callingCodeOf(digits) {
  const parsed = digits ? parsePhoneNumberFromString(`+${String(digits).replace(/\D/g, '')}`) : null;
  return parsed?.countryCallingCode || null;
}

const score = parsed => (parsed?.isValid() ? 2 : parsed?.isPossible() ? 1 : 0);
const NEEDS_COUNTRY = 'Include the country code, for example +1 857 707 5969 (or send "countryCode": "1").';

// `countryCode` — what the caller said the national number belongs to (explicit).
// `defaultCallingCode` — fallback when the caller said nothing (the account's own country).
// Returns { digits, e164, country } or { error }.
export function normalizePhone(input, { countryCode, defaultCallingCode } = {}) {
  const raw = String(input ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return { error: 'phone must be a phone number' };
  const done = parsed => ({ digits: parsed.number.slice(1), e164: parsed.number, country: parsed.country || null });

  // Written with an explicit country code: trust it. WhatsApp itself is the final judge
  // of whether the number exists, so a merely plausible number is allowed through.
  if (raw.startsWith('+') || digits.startsWith('00')) {
    const parsed = parsePhoneNumberFromString(`+${raw.startsWith('+') ? digits : digits.replace(/^00/, '')}`);
    return parsed && parsed.isPossible() ? done(parsed) : { error: `"${raw}" is not a valid international phone number. ${NEEDS_COUNTRY}` };
  }

  let explicit = null;
  if (countryCode !== undefined && countryCode !== null && String(countryCode).trim() !== '') {
    explicit = resolveCallingCode(countryCode);
    if (!explicit) return { error: 'countryCode must be a calling code such as 1, 55 or +55, or a two-letter country such as US or BR' };
  }
  const calling = explicit || defaultCallingCode || null;

  const asTyped = parsePhoneNumberFromString(`+${digits}`);                  // the country code is already in the digits
  const national = calling ? parsePhoneNumberFromString(raw, { defaultCallingCode: calling }) : null;

  if (explicit) {
    // The caller named the country: prefer reading the number as national there, and
    // accept anything WhatsApp could plausibly hold.
    const best = score(national) >= score(asTyped) ? national : asTyped;
    return score(best) ? done(best) : { error: `"${raw}" is not a valid phone number for country code +${explicit}` };
  }
  // Nothing explicit: only a number that is fully valid is accepted, never a guess.
  const best = score(asTyped) >= score(national) ? asTyped : national;
  return score(best) === 2 ? done(best) : { error: `Cannot tell which country "${raw}" belongs to. ${NEEDS_COUNTRY}` };
}
