const entries = [
  ["abc1", "ABC News", "https://abcnews.com/", "http", "complete"],
  ["cbs1", "CBS News", "https://www.cbsnews.com/", "http", "complete"],
  ["usat1", "USA Today", "https://www.usatoday.com/", "browser", "complete"],
  ["nbc1", "NBC News", "https://www.nbcnews.com/", "browser", "complete"],
  ["cnn1", "CNN", "https://www.cnn.com/", "browser", "complete"],
  ["guardian1", "The Guardian", "https://www.theguardian.com/", "browser", "partial-capable"],
  ["apgoogle1", "AP via Google News", "https://news.google.com/search?q=site%3Aapnews.com%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen", "http", "none"],
  ["latimes1", "Los Angeles Times", "https://www.latimes.com/", "http", "partial-capable"],
  ["npr1", "NPR", "https://www.npr.org/", "http", "partial-capable"],
  ["bbc1", "BBC", "https://www.bbc.com/", "http", "partial-capable"],
  ["fox1", "Fox News", "https://www.foxnews.com/", "http", "partial-capable"],
  ["yahoo1", "Yahoo News", "https://www.yahoo.com/news/", "browser", "partial-capable"],
];

export const PUBLISHERS = Object.freeze(entries.map(([id, name, homeUrl, primaryMethod, top10]) => Object.freeze({
  id,
  name,
  homeUrl,
  primaryMethod,
  kind: id === "apgoogle1" ? "discovery" : "hero",
  browserFallback: id !== "apgoogle1",
  browserAdapterAvailable: id !== "apgoogle1",
  httpAdapterAvailable: id !== "cnn1",
  rankingAdapterAvailable: top10 !== "none",
  top10,
  storyIntelligence: id !== "apgoogle1",
})));

export const PUBLISHER_IDS = Object.freeze(PUBLISHERS.map(({ id }) => id));
export const publisherById = Object.freeze(Object.fromEntries(PUBLISHERS.map((publisher) => [publisher.id, publisher])));
