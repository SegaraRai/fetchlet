export function format() {
  const day = Date.UTC(2024, 0, 2);
  return {
    canonical: Intl.getCanonicalLocales("EN-us"),
    locale: new Intl.Locale("ja-JP").language,
    plural: [new Intl.PluralRules("en").select(1), new Intl.PluralRules("en").select(2)],
    number: new Intl.NumberFormat("ja", {
      style: "currency",
      currency: "JPY",
    }).format(1234),
    utc: new Intl.DateTimeFormat("en", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(day),
    tokyo: new Intl.DateTimeFormat("ja", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(day),
    frenchSupported: Intl.DateTimeFormat.supportedLocalesOf("fr").length > 0,
    usesFormatJS: typeof Intl.DateTimeFormat.__addLocaleData === "function",
  };
}
