const entries = [
  ["abc1", "ABC News", "https://abcnews.com/", "http", "complete"],
  ["cbs1", "CBS News", "https://www.cbsnews.com/", "http", "complete"],
  ["usat1", "USA Today", "https://www.usatoday.com/", "browser", "complete"],
  ["nbc1", "NBC News", "https://www.nbcnews.com/", "browser", "complete"],
  ["cnn1", "CNN", "https://www.cnn.com/", "browser", "complete"],
  ["guardian1", "The Guardian", "https://www.theguardian.com/", "browser", "partial-capable"],
  ["ap1", "Associated Press", "https://apnews.com/", "browser", "complete"],
  ["latimes1", "Los Angeles Times", "https://www.latimes.com/", "http", "none"],
  ["npr1", "NPR", "https://www.npr.org/", "http", "none"],
  ["bbc1", "BBC", "https://www.bbc.com/", "http", "none"],
  ["fox1", "Fox News", "https://www.foxnews.com/", "http", "none"],
  ["yahoo1", "Yahoo News", "https://www.yahoo.com/news/", "browser", "partial-capable"],
];

export const PUBLISHERS = Object.freeze(entries.map(([id, name, homeUrl, primaryMethod, top10]) => Object.freeze({
  id,
  name,
  homeUrl,
  primaryMethod,
  browserFallback: true,
  top10,
  storyIntelligence: true,
})));

export const PUBLISHER_IDS = Object.freeze(PUBLISHERS.map(({ id }) => id));
export const publisherById = Object.freeze(Object.fromEntries(PUBLISHERS.map((publisher) => [publisher.id, publisher])));
