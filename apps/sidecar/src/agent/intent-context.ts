// ---------------------------------------------------------------------------
// Intent Context — pre-injects real-time data (time / weather) into the
// system prompt when the user's message implies a need for it.
// ---------------------------------------------------------------------------

export type IntentRoute = "local_time" | "weather" | "none";

export interface IntentContextResult {
  route: IntentRoute;
  context: string | null;
}

// ---------------------------------------------------------------------------
// Weather location registry (mirrors server liveCapabilities.ts)
// ---------------------------------------------------------------------------

interface WeatherLocation {
  city: string;
  lat: number;
  lon: number;
  tz: string;
  aliases: string[];
}

const WEATHER_LOCATIONS: WeatherLocation[] = [
  {
    city: "Shanghai",
    lat: 31.2304,
    lon: 121.4737,
    tz: "Asia/Shanghai",
    aliases: ["上海", "shanghai"],
  },
  {
    city: "Beijing",
    lat: 39.9042,
    lon: 116.4074,
    tz: "Asia/Shanghai",
    aliases: ["北京", "beijing"],
  },
  {
    city: "Shenzhen",
    lat: 22.5431,
    lon: 114.0579,
    tz: "Asia/Shanghai",
    aliases: ["深圳", "shenzhen"],
  },
  {
    city: "Guangzhou",
    lat: 23.1291,
    lon: 113.2644,
    tz: "Asia/Shanghai",
    aliases: ["广州", "guangzhou"],
  },
  {
    city: "Hangzhou",
    lat: 30.2741,
    lon: 120.1551,
    tz: "Asia/Shanghai",
    aliases: ["杭州", "hangzhou"],
  },
  {
    city: "Chengdu",
    lat: 30.5728,
    lon: 104.0668,
    tz: "Asia/Shanghai",
    aliases: ["成都", "chengdu"],
  },
  { city: "Tokyo", lat: 35.6764, lon: 139.65, tz: "Asia/Tokyo", aliases: ["东京", "tokyo"] },
  { city: "London", lat: 51.5072, lon: -0.1276, tz: "Europe/London", aliases: ["伦敦", "london"] },
  {
    city: "New York",
    lat: 40.7128,
    lon: -74.006,
    tz: "America/New_York",
    aliases: ["纽约", "new york", "newyork"],
  },
  {
    city: "San Francisco",
    lat: 37.7749,
    lon: -122.4194,
    tz: "America/Los_Angeles",
    aliases: ["旧金山", "san francisco", "sf"],
  },
];

const WEATHER_FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

function classifyIntent(prompt: string): IntentRoute {
  const lower = prompt.toLowerCase();

  // Time intent
  if (/几点|时间|日期|today|what time|what day|星期|周几|几号|几月/.test(lower)) {
    return "local_time";
  }

  // Weather intent
  if (/天气|气温|下雨|下雪|weather|temperature|forecast|晴|阴|风/.test(lower)) {
    return "weather";
  }

  return "none";
}

// ---------------------------------------------------------------------------
// Time context
// ---------------------------------------------------------------------------

function buildTimeContext(): IntentContextResult {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: timezone,
  }).format(now);
  const localDateTime = now.toLocaleString("sv-SE", { timeZone: timezone }).replace(" ", "T");

  return {
    route: "local_time",
    context: [
      "Local time context:",
      `- timezone: ${timezone}`,
      `- local_datetime: ${localDateTime}`,
      `- weekday: ${weekday}`,
      "Answer using this local time context.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Weather context
// ---------------------------------------------------------------------------

function resolveLocation(prompt: string): WeatherLocation | undefined {
  const lower = prompt.toLowerCase();
  return WEATHER_LOCATIONS.find((loc) => loc.aliases.some((alias) => lower.includes(alias)));
}

function describeWeatherCode(code: unknown): string {
  switch (code) {
    case 0:
      return "Clear";
    case 1:
    case 2:
    case 3:
      return "Partly cloudy";
    case 45:
    case 48:
      return "Fog";
    case 51:
    case 53:
    case 55:
    case 56:
    case 57:
      return "Drizzle";
    case 61:
    case 63:
    case 65:
    case 66:
    case 67:
      return "Rain";
    case 71:
    case 73:
    case 75:
    case 77:
      return "Snow";
    case 80:
    case 81:
    case 82:
      return "Rain showers";
    case 85:
    case 86:
      return "Snow showers";
    case 95:
    case 96:
    case 99:
      return "Thunderstorm";
    default:
      return "Unknown";
  }
}

function serializeNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}` : "unknown";
}

async function buildWeatherContext(prompt: string): Promise<IntentContextResult> {
  const location = resolveLocation(prompt);
  if (!location) {
    return {
      route: "weather",
      context:
        "Weather lookup requires an explicit city or location from the user. " +
        "Do not infer the user location. Ask the user to provide a city before answering weather.",
    };
  }

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", `${location.lat}`);
    url.searchParams.set("longitude", `${location.lon}`);
    url.searchParams.set(
      "current",
      "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    );
    url.searchParams.set(
      "daily",
      "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    );
    url.searchParams.set("timezone", location.tz);
    url.searchParams.set("forecast_days", "1");

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { route: "weather", context: "Weather data temporarily unavailable." };
    }

    const data = (await resp.json()) as {
      current?: Record<string, unknown>;
      daily?: Record<string, unknown[]>;
    };

    const current = data.current || {};
    const daily = data.daily || {};
    const high = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : undefined;
    const low = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : undefined;
    const precipitation = Array.isArray(daily.precipitation_probability_max)
      ? daily.precipitation_probability_max[0]
      : undefined;
    const weatherCode =
      current.weather_code ??
      (Array.isArray(daily.weather_code) ? daily.weather_code[0] : undefined);

    const contextString = [
      `Live weather for ${location.city} (${location.tz}):`,
      `- current_temperature_c: ${serializeNumber(current.temperature_2m)}`,
      `- apparent_temperature_c: ${serializeNumber(current.apparent_temperature)}`,
      `- weather: ${describeWeatherCode(weatherCode)}`,
      `- today_min_c: ${serializeNumber(low)}`,
      `- today_max_c: ${serializeNumber(high)}`,
      `- today_precipitation_probability_max: ${serializeNumber(precipitation)}`,
      `- wind_speed_10m_kmh: ${serializeNumber(current.wind_speed_10m)}`,
      "Use only this live weather data. Do not invent unavailable fields.",
    ].join("\n");

    return { route: "weather", context: contextString };
  } catch {
    return { route: "weather", context: "Weather data temporarily unavailable." };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildIntentContext(prompt: string): Promise<IntentContextResult> {
  const route = classifyIntent(prompt);

  if (route === "local_time") {
    return buildTimeContext();
  }

  if (route === "weather") {
    return buildWeatherContext(prompt);
  }

  return { route: "none", context: null };
}
