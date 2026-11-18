// QuotaExceededError (https://webidl.spec.whatwg.org/#quotaexceedederror), the
// DOMException subclass that reports the quota and the requested amount.

import { exposeAttributes } from "./idl";

function amount(value: unknown, member: string): number | null {
  if (value === undefined) {
    return null;
  }
  const number = +(value as number);
  if (!Number.isFinite(number)) {
    throw new TypeError(`The ${member} is not a finite number`);
  }
  if (number < 0) {
    throw new RangeError(`The ${member} is negative`);
  }
  return number;
}

export function createQuotaExceededError(Base: any) {
  const amounts = new WeakMap<object, { quota: number | null; requested: number | null }>();

  class QuotaExceededError extends Base {
    constructor(message: unknown = "", options: any = {}) {
      super(message, "QuotaExceededError");
      const quota = amount(options?.quota, "quota");
      const requested = amount(options?.requested, "requested");
      if (quota !== null && requested !== null && requested < quota) {
        throw new RangeError("The requested amount is below the quota");
      }
      amounts.set(this, { quota, requested });
    }

    get quota(): number | null {
      return amounts.get(this)?.quota ?? null;
    }

    get requested(): number | null {
      return amounts.get(this)?.requested ?? null;
    }
  }

  exposeAttributes(QuotaExceededError.prototype, ["quota", "requested"]);
  return QuotaExceededError;
}
