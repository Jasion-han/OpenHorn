export type LiveRouteType =
  | "local"
  | "structured_live"
  | "web_search"
  | "research"
  | "direct_model";

export type LiveStatus = "live" | "offline";

import { buildSearchContext, type SearchCitation } from "./searchService";

export type LiveSourceType = "local" | "weather" | "web_search" | "none";

export type LiveRoute = {
  type: LiveRouteType;
  needsCitation: boolean;
};

export type WebSearchPolicy =
  | "never"
  | "always_web_search"
  | "always_research"
  | "defer_to_router";

export type StoredLiveMetadata = {
  status: LiveStatus;
  route: LiveRouteType;
  label: string;
  sourceType: LiveSourceType;
};

export type LiveContextResult = {
  status: LiveStatus;
  route: LiveRouteType;
  userLabel: string;
  source: {
    type: LiveSourceType;
    provider?: string;
    city?: string;
  };
  systemContext?: string;
  citations?: SearchCitation[];
};

export type BuildLiveContextInput = {
  prompt: string;
  timezone?: string;
  now?: Date;
  fetchImpl?: FetchFn;
  userSettings?: Record<string, string>;
  tavilyEnvKey?: string | null;
  forceWebSearch?: boolean;
  classifier?: (prompt: string) => Promise<LiveRouteType | null>;
};

type FetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

type WeatherLocation = {
  city: string;
  latitude: number;
  longitude: number;
  timezone: string;
  aliases: string[];
};

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_FETCH: FetchFn = fetch;

const WEATHER_LOCATIONS: WeatherLocation[] = [
  {
    city: "Shanghai",
    latitude: 31.2304,
    longitude: 121.4737,
    timezone: "Asia/Shanghai",
    aliases: ["上海", "shanghai"],
  },
  {
    city: "Beijing",
    latitude: 39.9042,
    longitude: 116.4074,
    timezone: "Asia/Shanghai",
    aliases: ["北京", "beijing"],
  },
  {
    city: "Shenzhen",
    latitude: 22.5431,
    longitude: 114.0579,
    timezone: "Asia/Shanghai",
    aliases: ["深圳", "shenzhen"],
  },
  {
    city: "Guangzhou",
    latitude: 23.1291,
    longitude: 113.2644,
    timezone: "Asia/Shanghai",
    aliases: ["广州", "guangzhou"],
  },
  {
    city: "Hangzhou",
    latitude: 30.2741,
    longitude: 120.1551,
    timezone: "Asia/Shanghai",
    aliases: ["杭州", "hangzhou"],
  },
  {
    city: "Chengdu",
    latitude: 30.5728,
    longitude: 104.0668,
    timezone: "Asia/Shanghai",
    aliases: ["成都", "chengdu"],
  },
  {
    city: "Tokyo",
    latitude: 35.6764,
    longitude: 139.65,
    timezone: "Asia/Tokyo",
    aliases: ["东京", "tokyo"],
  },
  {
    city: "London",
    latitude: 51.5072,
    longitude: -0.1276,
    timezone: "Europe/London",
    aliases: ["伦敦", "london"],
  },
  {
    city: "New York",
    latitude: 40.7128,
    longitude: -74.006,
    timezone: "America/New_York",
    aliases: ["纽约", "new york", "newyork"],
  },
  {
    city: "San Francisco",
    latitude: 37.7749,
    longitude: -122.4194,
    timezone: "America/Los_Angeles",
    aliases: ["旧金山", "san francisco", "sf"],
  },
];

function normalizePrompt(prompt: string) {
  return prompt.trim().toLowerCase();
}

function inferTimezone(input?: string) {
  return input?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
}

function joinContextLines(lines: Array<string | null | undefined>) {
  return lines.filter((line): line is string => Boolean(line?.trim())).join("\n");
}

function serializeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? `${value}` : "unknown";
}

function formatIsoLocal(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const part = (type: string) => parts.find((item) => item.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function describeWeatherCode(code: unknown) {
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

function resolveWeatherLocation(prompt: string) {
  const text = normalizePrompt(prompt);
  return WEATHER_LOCATIONS.find((location) =>
    location.aliases.some((alias) => text.includes(alias)),
  );
}

function looksLikeNamedToolOrProductQuery(prompt: string) {
  const text = prompt.trim();
  if (!text) return false;

  const hasAsciiEntityToken =
    /\b[A-Z][A-Za-z0-9-]{2,}\b/.test(text) ||
    /\b[a-z]+[A-Z][A-Za-z0-9-]*\b/.test(text) ||
    /\b[A-Za-z]*\d+[A-Za-z0-9-]*\b/.test(text);

  const hasEntityLookupIntent =
    /是什么|是啥|介绍|能力|功能|特性|优势|优点|缺点|怎么样|如何|支持什么|适合什么|适用什么|文档|官网|价格|定价|收费|区别|对比|比较|相较于/i.test(
      text,
    );

  return hasAsciiEntityToken && hasEntityLookupIntent;
}

function looksLikeCurrentPracticeOrTrendQuery(prompt: string) {
  const text = prompt.trim();
  if (!text) return false;

  const hasCurrentSignal =
    /现在|当前|目前|现阶段|如今|当下|一般|通常|主流|趋势|现状|怎么面|怎么做|怎么搞|best practice|best practices|current practice|current trend|industry norm/i.test(
      text,
    );

  const hasPracticeDomain =
    /面试|招聘|求职|岗位|流程|行业|市场|技术方向|差异|区别|对比|比较|实践|做法|要求|标准/i.test(
      text,
    );

  return hasCurrentSignal && hasPracticeDomain;
}

export function getWebSearchPolicy(prompt: string): WebSearchPolicy {
  const text = prompt.trim();
  if (!text) return "never";

  if (
    /^(hi|hello|hey|你好|您好|嗨|哈喽|早上好|晚上好|谢谢|thanks?)[\s!.?]*$/i.test(text) ||
    /你是谁|你是誰|你是什么模型|你是啥模型|你是哪个模型|你是哪种模型|who are you|what model are you|which model are you/i.test(
      text,
    ) ||
    /你能做什么|你会做什么|what can you do/i.test(text) ||
    /翻译|translate|润色|改写|重写|paraphrase|rewrite|总结|摘要|summari[sz]e|解释这段|解释一下这段|解释代码|explain this code/i.test(
      text,
    )
  ) {
    return "never";
  }

  if (/比较.*最近|分析.*最近|调研|汇总.*最近|survey|research/i.test(text)) {
    return "always_research";
  }

  if (looksLikeCurrentPracticeOrTrendQuery(text)) {
    return /差异|区别|对比|比较/i.test(text) ? "always_research" : "always_web_search";
  }

  if (
    /最新|最近|刚刚|今日|今天.*新闻|发布了什么|发生了什么|现价|股价|比分|战绩|热搜|新闻|news|recent|latest|today/i.test(
      text,
    ) ||
    /帮我查|搜一下|查一下|look up|search for|find online|官网|官方文档|给我链接|给我来源|给出处/i.test(
      text,
    )
  ) {
    return "always_web_search";
  }

  return "defer_to_router";
}

function buildOfflineResult(
  route: LiveRouteType,
  userLabel: string,
  systemContext?: string,
): LiveContextResult {
  return {
    status: "offline",
    route,
    userLabel,
    source: { type: "none" },
    systemContext,
  };
}

async function resolveWeatherContext(input: BuildLiveContextInput): Promise<LiveContextResult> {
  const location = resolveWeatherLocation(input.prompt);
  if (!location) {
    return buildOfflineResult(
      "structured_live",
      "缺少位置，未查询天气",
      "Weather lookup requires an explicit city or location from the user. Do not infer the user location. Ask the user to provide a city before answering weather.",
    );
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", `${location.latitude}`);
  url.searchParams.set("longitude", `${location.longitude}`);
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,precipitation,rain,showers,snowfall,weather_code,wind_speed_10m",
  );
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
  );
  url.searchParams.set("timezone", location.timezone);
  url.searchParams.set("forecast_days", "1");

  try {
    const response = await (input.fetchImpl || DEFAULT_FETCH)(url.toString());
    if (!response.ok) {
      return buildOfflineResult(
        "structured_live",
        "实时服务暂不可用，本轮为离线回答",
        "Live weather lookup failed. Do not claim current weather data. Briefly state that live weather is unavailable.",
      );
    }

    const payload = (await response.json()) as {
      current?: Record<string, unknown>;
      daily?: Record<string, unknown[]>;
    };

    const current = payload.current || {};
    const daily = payload.daily || {};
    const high = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : undefined;
    const low = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : undefined;
    const precipitation = Array.isArray(daily.precipitation_probability_max)
      ? daily.precipitation_probability_max[0]
      : undefined;
    const weatherCode =
      current.weather_code ??
      (Array.isArray(daily.weather_code) ? daily.weather_code[0] : undefined);

    return {
      status: "live",
      route: "structured_live",
      userLabel: `已使用天气数据 · ${location.city}`,
      source: {
        type: "weather",
        provider: "open-meteo",
        city: location.city,
      },
      systemContext: joinContextLines([
        `Live weather for ${location.city} (${location.timezone}):`,
        `- current_temperature_c: ${serializeNumber(current.temperature_2m)}`,
        `- apparent_temperature_c: ${serializeNumber(current.apparent_temperature)}`,
        `- weather: ${describeWeatherCode(weatherCode)}`,
        `- today_min_c: ${serializeNumber(low)}`,
        `- today_max_c: ${serializeNumber(high)}`,
        `- today_precipitation_probability_max: ${serializeNumber(precipitation)}`,
        `- wind_speed_10m_kmh: ${serializeNumber(current.wind_speed_10m)}`,
        "Use only this live weather data. Do not invent unavailable fields.",
      ]),
    };
  } catch {
    return buildOfflineResult(
      "structured_live",
      "实时服务暂不可用，本轮为离线回答",
      "Live weather lookup failed. Do not claim current weather data. Briefly state that live weather is unavailable.",
    );
  }
}

export function routeLiveQuery(prompt: string): LiveRoute {
  const text = prompt.trim();
  const policy = getWebSearchPolicy(text);

  if (policy === "never") {
    return { type: "direct_model", needsCitation: false };
  }

  if (/周几|星期|几点|几号|日期|时间|时区|timezone|date|time/i.test(text)) {
    return { type: "local", needsCitation: false };
  }

  if (/天气|下雨|气温|温度|weather|forecast/i.test(text)) {
    return { type: "structured_live", needsCitation: false };
  }

  if (policy === "always_research" || /比较|分析|调研|汇总|整理.*最近|research|survey/i.test(text)) {
    return { type: "research", needsCitation: true };
  }

  if (
    policy === "always_web_search" ||
    /最近|最新|刚刚|今天.*新闻|发布了什么|发生了什么|news|recent|today/i.test(text)
  ) {
    return { type: "web_search", needsCitation: true };
  }

  return { type: "direct_model", needsCitation: false };
}

function routeFromType(type: LiveRouteType): LiveRoute {
  return {
    type,
    needsCitation: type === "web_search" || type === "research",
  };
}

export async function buildLiveContext(input: BuildLiveContextInput): Promise<LiveContextResult> {
  let route = routeLiveQuery(input.prompt);
  const timezone = inferTimezone(input.timezone);
  const webSearchPolicy = getWebSearchPolicy(input.prompt);
  const allowSemanticWebRouting = webSearchPolicy === "defer_to_router";

  if (
    route.type === "direct_model" &&
    allowSemanticWebRouting &&
    input.forceWebSearch &&
    looksLikeNamedToolOrProductQuery(input.prompt)
  ) {
    route = routeFromType(
      /区别|对比|比较|相较于/i.test(input.prompt) ? "research" : "web_search",
    );
  }

  if (route.type === "direct_model" && allowSemanticWebRouting && input.classifier) {
    const classified = await input.classifier(input.prompt);
    if (classified) {
      route = routeFromType(classified);
    }
  }

  if (route.type === "local") {
    const now = input.now ?? new Date();
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      timeZone: timezone,
    }).format(now);

    return {
      status: "live",
      route: route.type,
      userLabel: "已使用本地时间",
      source: { type: "local" },
      systemContext: joinContextLines([
        "Local time context:",
        `- timezone: ${timezone}`,
        `- local_datetime: ${formatIsoLocal(now, timezone)}`,
        `- weekday: ${weekday}`,
        "Answer using this local time context. Do not claim web search.",
      ]),
    };
  }

  if (route.type === "structured_live") {
    return resolveWeatherContext(input);
  }

  if (route.type === "web_search" || route.type === "research") {
    const searchContext = await buildSearchContext({
      route: route.type,
      prompt: input.prompt,
      userSettings: input.userSettings,
      envKey: input.tavilyEnvKey,
      fetchImpl: input.fetchImpl,
    });

    return {
      status: searchContext.status,
      route: route.type,
      userLabel: searchContext.label,
      source: {
        type: searchContext.status === "live" ? "web_search" : "none",
        provider: searchContext.provider === "tavily" ? "tavily" : undefined,
      },
      systemContext: searchContext.systemContext,
      citations: searchContext.citations,
    };
  }

  return {
    status: "offline",
    route: route.type,
    userLabel: "未联网，直接回答",
    source: { type: "none" },
  };
}

export function toStoredLiveMetadata(result: LiveContextResult): StoredLiveMetadata {
  return {
    status: result.status,
    route: result.route,
    label: result.userLabel,
    sourceType: result.source.type,
  };
}
