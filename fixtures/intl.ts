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
    usesFormatJS:
      typeof (Intl.DateTimeFormat as { __addLocaleData?: unknown }).__addLocaleData === "function",
  };
}

// The Intl APIs beyond formatting numbers and dates, with results that
// native ICU and the FormatJS polyfills agree on.
export function formatText() {
  const intl = Intl as unknown as Record<string, new (...args: unknown[]) => any>;
  const words = [...new intl.Segmenter!("en", { granularity: "word" }).segment("Hello, world")] as {
    segment: string;
    isWordLike: boolean;
  }[];
  const graphemes = [...new intl.Segmenter!("en").segment("éa")];
  return {
    list: new intl.ListFormat!("en", { type: "conjunction" }).format(["a", "b", "c"]),
    listJa: new intl.ListFormat!("ja", { type: "conjunction" }).format(["a", "b", "c"]),
    region: new intl.DisplayNames!("en", { type: "region" }).of("JP"),
    languageJa: new intl.DisplayNames!("ja", { type: "language" }).of("en"),
    yesterday: new intl.RelativeTimeFormat!("en", { numeric: "auto" }).format(-1, "day"),
    inHoursJa: new intl.RelativeTimeFormat!("ja").format(3, "hour"),
    words: words.filter((segment) => segment.isWordLike).map((segment) => segment.segment),
    graphemes: graphemes.length,
    duration: new intl.DurationFormat!("en", { style: "long" }).format({ hours: 1, minutes: 30 }),
    digital: new intl.DurationFormat!("en", { style: "digital" }).format({
      hours: 1,
      minutes: 5,
      seconds: 3,
    }),
  };
}
