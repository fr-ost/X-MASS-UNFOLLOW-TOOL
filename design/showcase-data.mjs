// Fictional accounts for store screenshots. Every name, handle and bio is
// invented; any resemblance to a real account is coincidental.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const FIRST = ["Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Maya", "Leo", "Nina", "Omar", "Priya", "Ethan", "Zoe", "Lucas", "Aria", "Mateo", "Hana", "Ivan", "Lena", "Noah", "Sara", "Theo", "Yara", "Kai", "Mila", "Elias", "Ines", "Ravi", "Chloe", "Diego", "Amara", "Felix", "Grace", "Hugo", "Isla", "Jonas"];
const LAST = ["Rivera", "Chen", "Patel", "Okafor", "Kim", "Novak", "Silva", "Haddad", "Larsen", "Moreau", "Ito", "Mensah", "Costa", "Fischer", "Nakamura", "Reyes", "Andersen", "Khan", "Duarte", "Weber", "Rossi", "Sato", "Ahmed", "Brooks", "Nguyen", "Volkov", "Ortiz", "Lindqvist", "Adeyemi", "Park"];
const TOPICS = ["Product designer", "Frontend dev", "Indie hacker", "Photographer", "Data scientist", "Founder", "Writer", "Marketer", "PhD student", "iOS engineer", "Growth lead", "3D artist", "Podcaster", "Teacher", "Travel blogger", "Security researcher", "Musician", "Product manager", "Illustrator", "Startup advisor"];
const TAILS = ["Coffee first.", "Building in public.", "Opinions are my own.", "Always learning.", "Based in Berlin.", "Lisbon / remote.", "Dog person.", "Shipping small things.", "Newsletter in bio.", "Ex-agency, now solo.", "Running on cold brew.", "Tokyo-based."];
const BRANDS = [
  ["Growth Hacks Daily", "growthhacks_daily", "Daily growth tips for creators. Promo in bio.", { v: true, fc: 48200, fr: 51200, sc: 9800 }],
  ["Pixel & Pine Studio", "pixelpinestudio", "Brand identity and UI design studio. Portland.", { fc: 12400, fr: 880, sc: 2300 }],
  ["Free Giveaways 2026", "free_giveaways26", "Daily giveaways. Turn on notifications!", { d: true, fc: 12, fr: 4980, sc: 3 }],
  ["Jordan Blake", "jordanblake_io", "Building in public. SaaS, coffee and long runs.", { fc: 3200, fr: 410, sc: 5400 }],
  ["Nomad Notes", "nomad_notes", "Travel stories from 60 countries and counting.", { p: true, fc: 940, fr: 312, sc: 760 }],
  ["Tech Deals Bot", "techdeals_bot", "Automated deals feed. Not monitored.", { fc: 890, fr: 7400, sc: 21000 }],
  ["Sofia Martinez", "sofiamtz_codes", "Frontend dev. React, CSS and good typography.", { v: true, fc: 18300, fr: 640, sc: 8100 }],
  ["Daily Motivation", "motivation_hq", "Quotes to start your day.", { v: true, fc: 230000, fr: 12, sc: 41000 }],
  ["Market Pulse", "marketpulse_live", "Stocks, crypto and macro - all day.", { v: true, fc: 86000, fr: 220, sc: 120000 }],
  ["Ryan Okafor", "ryanokafor", "Photographer. Lagos to London.", { p: true, fc: 2100, fr: 530, sc: 1200 }],
  ["AI Tools Weekly", "aitoolsweekly", "The best new AI tools, every Friday.", { fc: 27400, fr: 3100, sc: 1900 }],
  ["Hannah Lee", "hannahlee_ux", "Product designer at a startup you haven't heard of yet.", { fc: 5600, fr: 900, sc: 3300 }],
  ["Promo Central", "promo_central_x", "Follow back guaranteed!!", { d: true, fc: 33, fr: 6200, sc: 7 }],
  ["Café Atlas", "cafe_atlas", "Specialty coffee roasters. Since 2014.", { fc: 7100, fr: 1500, sc: 2600 }]
];

export function showcase() {
  const r = rng(20261002);
  const users = [];
  let id = 300000;
  const push = (n, h, b, o, fy) => {
    users.push(Object.assign({
      id: String(id++), h, n, b, fy,
      v: false, p: false, d: false,
      fc: Math.round(Math.exp(3 + r() * 7)), fr: Math.round(80 + r() * 1800), sc: Math.round(Math.exp(2 + r() * 7)),
      ca: new Date(Date.UTC(2009 + Math.floor(r() * 16), Math.floor(r() * 12), 1 + Math.floor(r() * 27))).toUTCString()
    }, o || {}));
  };
  // The newest follows: brand-ish accounts that mostly don't follow back,
  // interleaved with a few mutual friends.
  BRANDS.forEach(([n, h, b, o], i) => {
    push(n, h, b, o, false);
    if (i % 3 === 2) {
      const f = FIRST[i % FIRST.length], l = LAST[(i * 7) % LAST.length];
      push(`${f} ${l}`, `${f}${l}`.toLowerCase().slice(0, 13) + i, `${TOPICS[i % TOPICS.length]}. ${TAILS[i % TAILS.length]}`, {}, true);
    }
  });
  const seen = new Set(users.map((u) => u.h));
  while (users.length < 1834) {
    const f = FIRST[Math.floor(r() * FIRST.length)], l = LAST[Math.floor(r() * LAST.length)];
    let h = (r() < .5 ? `${f}${l}` : `${f}_${l}`).toLowerCase().slice(0, 12) + (r() < .5 ? Math.floor(r() * 99) : "");
    if (seen.has(h)) continue;
    seen.add(h);
    const fy = r() > 0.226;
    push(`${f} ${l}`, h, `${TOPICS[Math.floor(r() * TOPICS.length)]}. ${TAILS[Math.floor(r() * TAILS.length)]}`, {
      v: r() < .1, p: r() < .05, d: r() < .04
    }, fy);
  }
  return {
    owner: { id: "1000", handle: "alexrivera_dev", name: "Alex Rivera" },
    users
  };
}
