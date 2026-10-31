// Swedish applied comprehension (8 points). A seeded fictional municipality publishes a notice, a
// later authoritative amendment with a stated scope, and residents argue on a forum. Eight questions
// in Swedish, each built on one convention a non-Swedish reading gets wrong, plus two short Swedish
// replies with a requested register. Scored on normalized values, two designated source citations and
// two constrained replies; never on a stopword ratio.
import {
  rng, utc, iso, addDays, isoWeek, isoWeekMonday, SV_MONTHS, SV_DAYS, svDate,
  asText, norm, isUnknown, numberMatches, parseTime, parseDate, cites, round
} from './common.mjs';

const TOWNS = ['Lövsjö', 'Granvik', 'Björkdala', 'Åsbacka', 'Ekeryd', 'Mossberga', 'Tallnäs', 'Hjortö'];
const SERVICES = [
  { noun: 'badhuset', fee: 'entréavgiften', unit: 'besök' },
  { noun: 'återvinningscentralen', fee: 'avgiften för släpvagn', unit: 'tillfälle' },
  { noun: 'fritidsgården', fee: 'medlemsavgiften för vuxna', unit: 'termin' },
  { noun: 'kulturskolan', fee: 'kursavgiften', unit: 'termin' }
];
const AREAS = ['Norr', 'Söder', 'Väster', 'Öster', 'Centrum', 'Hamnen'];
const PLAIN = ['Andersson', 'Berg', 'Dahl', 'Holm', 'Lind', 'Nilsson', 'Sandberg', 'Torstensson', 'Gustafsson', 'Karlsson'];
const ZNAMES = ['Zander', 'Zetterlund', 'Zackrisson'];
const ARING = ['Åberg', 'Åkesson', 'Ålund'];
const AUML = ['Ärlig', 'Ängström', 'Älvdal'];
const OUML = ['Öberg', 'Östlund', 'Örn'];
const FIRST = ['Kim', 'Alex', 'Robin', 'Charlie', 'Sam', 'Love', 'Noa', 'Vide'];
const ASSOCIATIONS = ['Simklubben Vågen', 'Hyresgästföreningen Linden', 'Pensionärsföreningen Solrosen', 'Idrottsföreningen Kometen'];

// Idiomatic times: [phrase for hour h, minutes after (h-1) or after h]. All resolve unambiguously once
// the text says förmiddagen or eftermiddagen.
const IDIOMS = [
  { say: h => `halv ${h}`, at: h => [h - 1, 30] },
  { say: h => `kvart över ${h}`, at: h => [h, 15] },
  { say: h => `kvart i ${h}`, at: h => [h - 1, 45] },
  { say: h => `fem i halv ${h}`, at: h => [h - 1, 25] },
  { say: h => `fem över halv ${h}`, at: h => [h - 1, 35] },
  { say: h => `tjugo över ${h}`, at: h => [h, 20] }
];
const HOUR_WORDS = ['', 'ett', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio', 'tio', 'elva', 'tolv'];
// Mondays that fall in the previous calendar year or on a 52/53-week edge, all after the notice.
const WEEKS = [[1, 2028], [52, 2027], [1, 2030], [1, 2031], [53, 2032]];
const RELATIVE = [{ say: 'förrförra veckan', shift: -2 }, { say: 'förra veckan', shift: -1 }, { say: 'nästnästa vecka', shift: 2 }];
const PERIODS = [{ say: 'kvartal', per: 4 }, { say: 'månad', per: 12 }, { say: 'halvår', per: 2 }];
const svMoney = (whole, cents) => `${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(cents).padStart(2, '0')}`;
const svDecimal = n => String(n).replace('.', ',');

export function swedishChallenge(seed) {
  const r = rng(seed, 'swedish-v03');
  const town = r.pick(TOWNS), service = r.pick(SERVICES), [area, otherArea] = r.take(AREAS, 2);
  const tag = r.hex(4).toUpperCase();
  const id = { notice: `SV-KUNG-${tag}`, amendment: `SV-ANDR-${tag}`, forum: `SV-FORUM-${tag}` };
  const year = 2027;
  const noticeDate = utc(year, 1 + r.int(2), 5 + r.int(20));

  // s1: idiomatic time
  const idiom = r.pick(IDIOMS), afternoon = r.chance(0.6);
  const spokenHour = afternoon ? 2 + r.int(5) : 9 + r.int(3);
  const [hh, mm] = idiom.at(spokenHour);
  const time = `${String(hh + (afternoon ? 12 : 0)).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const timePhrase = `${idiom.say(HOUR_WORDS[spokenHour])} på ${afternoon ? 'eftermiddagen' : 'förmiddagen'}`;
  const meetingDay = addDays(noticeDate, 20 + r.int(20));

  // s2: decimal comma and space-grouped thousands
  const period = r.pick(PERIODS), whole = 1000 + r.int(9000), cents = r.pick([25, 50, 75]);
  const yearly = round((whole + cents / 100) * period.per);

  // s3: numeric date after the text states day/month order (d and m both <= 12 and different)
  const dd = 1 + r.int(12); let mo = 1 + r.int(12); if (mo === dd) mo = (mo % 12) + 1;
  const deadline = utc(year, mo, dd);

  // s4: long-scale number words
  const longScale = r.pick([{ word: 'miljarder', factor: 1000 }, { word: 'biljoner', factor: 1_000_000 }]);
  const amount = (10 + r.int(80)) / 10;
  const millions = round(amount * longScale.factor);

  // s5: ISO week Monday, often across a year boundary
  const [week, weekYear] = r.pick(WEEKS);
  const weekMonday = iso(isoWeekMonday(weekYear, week));

  // s6: Swedish collation, å ä ö after z
  const names = r.shuffle([...r.take(PLAIN, 2), r.pick(ZNAMES), r.pick(ARING), r.pick(AUML), r.pick(OUML)]);
  const RANK = 'abcdefghijklmnopqrstuvwxyzåäö';
  const sorted = [...names].sort((a, b) => RANK.indexOf(a[0].toLowerCase()) - RANK.indexOf(b[0].toLowerCase()) || a.localeCompare(b, 'sv'));

  // s7: relative week against the forum post's own date
  const rel = r.pick(RELATIVE);
  const forumDay = addDays(utc(year, 3 + r.int(6), 1), r.int(28));
  const relWeek = isoWeek(addDays(forumDay, 7 * rel.shift)).week;

  // s8: which fee applies to one resident on one day
  const baseFee = 40 + 5 * r.int(20), newFee = baseFee + 10 + 5 * r.int(6), rumourFee = newFee + 5 * (1 + r.int(4));
  const effective = utc(year, 5 + r.int(3), 1);
  const resident = r.pick(FIRST);
  const variant = r.pick(['in-scope', 'other-area', 'before-effective']);
  const residentArea = variant === 'other-area' ? otherArea : area;
  const askDay = variant === 'before-effective' ? addDays(effective, -(3 + r.int(20))) : addDays(effective, 3 + r.int(40));
  const applies = variant === 'in-scope';

  // Replies: the register is stated, never inferred from politeness.
  const duReply = r.chance(0.5);
  const recipient = duReply ? `invånaren ${r.pick(FIRST.filter(n => n !== resident))}` : `styrelsen i ${r.pick(ASSOCIATIONS)}`;

  const notice = [
    `# ${id.notice} — Kungörelse från ${town} kommun`,
    '',
    `Publicerad ${SV_DAYS[noticeDate.getUTCDay()]}en den ${svDate(noticeDate)}. Avsändare: kommunstyrelsens förvaltning.`,
    '',
    `I denna kungörelse skrivs datum med siffror som dag/månad.`,
    '',
    `1. Informationsmöte om ${service.noun} hålls den ${svDate(meetingDay)} klockan ${timePhrase}.`,
    `2. Sista dag att anmäla sig till referensgruppen är ${dd}/${mo}.`,
    `3. Ombyggnaden startar måndagen i vecka ${week} ${weekYear}.`,
    `4. Från och med 1 januari ${year} är ${service.fee} ${baseFee} kr per ${service.unit} för alla.`,
    `5. Driftbidraget betalas med ${svMoney(whole, cents)} kr per ${period.say}.`,
    `6. Det nationella programmet som ombyggnaden ingår i omfattar totalt ${svDecimal(amount)} ${longScale.word} kronor.`,
    `7. Kontaktpersoner i referensgruppen: ${names.join(', ')}.`,
    ''
  ].join('\n');
  const amendment = [
    `# ${id.amendment} — Ändring i kungörelse ${id.notice}`,
    '',
    `Beslutad av kommunfullmäktige i ${town} den ${svDate(addDays(effective, -30))}. Ändringen ersätter punkt 4 i ${id.notice} i den del som anges nedan; i övrigt gäller kungörelsen.`,
    '',
    `För den som är folkbokförd i område ${area} gäller från och med ${svDate(effective)} i stället ${service.fee} ${newFee} kr per ${service.unit}. För övriga områden gäller punkt 4 oförändrad.`,
    ''
  ].join('\n');
  const forum = [
    `# ${id.forum} — Forumtråd: "Ny avgift?"`,
    '',
    `Inlägg skrivet ${SV_DAYS[forumDay.getUTCDay()]}en den ${svDate(forumDay)} av användaren grannen_${tag.toLowerCase()}:`,
    '',
    `Jag var på ${service.noun} ${rel.say} och hörde i kassan att ${service.fee} blir ${rumourFee} kr för alla i hela kommunen. Ingen har läst något beslut, men alla säger så.`,
    ''
  ].join('\n');

  const docs = r.shuffle([[id.forum, forum], [id.notice, notice], [id.amendment, amendment]]);
  const questions = [
    ['s1', `Vilken tid börjar informationsmötet? Svara i 24-timmarsformat (tt:mm).`],
    ['s2', `Hur många kronor betalas i driftbidrag under ett helt år? Svara med ett tal.`],
    ['s3', `Vilket datum är sista anmälningsdag? Svara som ÅÅÅÅ-MM-DD och ange källans id i "source".`],
    ['s4', `Hur många miljoner kronor omfattar det nationella programmet totalt? Svara med ett tal.`],
    ['s5', `Vilket datum startar ombyggnaden? Svara som ÅÅÅÅ-MM-DD.`],
    ['s6', `Lista kontaktpersonernas efternamn i svensk alfabetisk ordning.`],
    ['s7', `Vilket ISO-veckonummer syftar forumskribenten på med "${rel.say}"? Svara med ett tal.`],
    ['s8', `${resident} är folkbokförd i område ${residentArea}. Vad är ${service.fee} för ${resident} per ${service.unit} den ${svDate(askDay)}? Svara med ett tal och ange källans id i "source".`],
    ['r1', `Skriv en mening på svenska, högst 25 ord, till ${recipient} med ${duReply ? 'du' : 'ni'}-tilltal, som säger vilket datum som är sista anmälningsdag.`],
    ['r2', `Förklara med en mening på svenska varför forumets uppgift om ${rumourFee} kr inte stämmer för ${resident}, och nämn id:t på källan som avgör saken.`]
  ];
  const task = [
    `# Svenska: kommunala beslut (challenge ${'%ID%'})`,
    '',
    `Läs bara dokumenten i \`corpus/v03-svenska/\`. Allt du behöver finns där. Svara på frågorna och spara`,
    `svaret som \`swedish.json\`, med samma "challenge"-värde som ovan:`,
    '',
    '```json',
    '{"challenge": "%ID%", "answers": {"s1": {"answer": "..."}, "s3": {"answer": "...", "source": "..."}, "r1": {"answer": "..."}}}',
    '```',
    '',
    `Varje fråga har ett eget fält (s1–s8, r1–r2). Svara "okänt" om något inte går att avgöra från dokumenten.`,
    '',
    ...questions.map(([q, text]) => `- **${q}.** ${text}`),
    ''
  ].join('\n');

  const key = {
    s1: { kind: 'time', value: time, trap: 'idiom' },
    s2: { kind: 'number', value: yearly, tolerance: 0.005 },
    s3: { kind: 'date', value: iso(deadline), wrong: iso(utc(year, dd, mo)), sources: [id.notice] },
    s4: { kind: 'number', value: millions },
    s5: { kind: 'date', value: weekMonday },
    s6: { kind: 'order', value: sorted },
    s7: { kind: 'number', value: relWeek },
    s8: { kind: 'number', value: applies ? newFee : baseFee, wrong: [applies ? baseFee : newFee, rumourFee], sources: applies ? [id.amendment] : [id.notice, id.amendment] },
    r1: { kind: 'reply', register: duReply ? 'du' : 'ni', date: iso(deadline), maxWords: 25 },
    r2: { kind: 'reply-source', sources: applies ? [id.amendment] : [id.notice, id.amendment] },
    year, variant
  };
  return {
    files: Object.fromEntries([['tasks/swedish.md', task], ...docs.map(([name, text]) => [`corpus/v03-svenska/${name}.md`, text])]),
    key,
    reference: referenceAnswers(key, duReply)
  };
}

// A careful answer, used to validate each generated case and the scorer.
function referenceAnswers(key, du) {
  const [y, m, d] = key.s3.value.split('-').map(Number);
  const date = `${d} ${SV_MONTHS[m - 1]} ${y}`;
  return {
    s1: { answer: key.s1.value }, s2: { answer: String(key.s2.value).replace('.', ',') }, s3: { answer: key.s3.value, source: key.s3.sources[0] },
    s4: { answer: String(key.s4.value) }, s5: { answer: key.s5.value }, s6: { answer: key.s6.value }, s7: { answer: key.s7.value },
    s8: { answer: `${key.s8.value} kr`, source: key.s8.sources[0] },
    r1: { answer: du ? `Hej, du kan anmäla dig till och med den ${date}.` : `Hej, ni kan anmäla er till och med den ${date}.` },
    r2: { answer: `Forumet är bara ett rykte och det är ${key.r2.sources[0]} som avgör vilken avgift som gäller.` }
  };
}

// A JavaScript word boundary is ASCII-only, so word edges are spelled out for å, ä and ö.
const W = alt => new RegExp(String.raw`(?<![\p{L}])(?:${alt})(?![\p{L}])`, 'giu');
const DU = W('du|dig|din|ditt|dina'), NI = W('ni|er|ert|era|eder');
const SV_MARKERS = W('och|att|är|det|som|en|ett|för|till|den|av|på|med|inte|kan|ska|sista|dag|gäller|bara|om|eftersom|enligt');
const FOREIGN = new RegExp(W('the|and|you|your|please|deadline|registration|because').source + '|[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]', 'iu');
const has = (re, t) => { re.lastIndex = 0; return re.test(t); };
const words = t => t.split(/\s+/).filter(Boolean).length;
const swedishEnough = t => (t.match(SV_MARKERS) ?? []).length >= 2 && !has(FOREIGN, t);

export function scoreSwedish(key, answers) {
  const review = [];
  const check = (q, ok, extra = {}) => ({ q, ok, ...extra });
  const content = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map(q => {
    const k = key[q], a = answers?.[q];
    const v = a && typeof a === 'object' && !Array.isArray(a) ? a.answer : a;
    if (isUnknown(v)) return check(q, false, { abstained: true });
    if (k.kind === 'time') return check(q, parseTime(v) === k.value);
    if (k.kind === 'date') return check(q, parseDate(v, key.year) === k.value);
    if (k.kind === 'number') {
      const m = numberMatches(v, k.value, k.tolerance ?? 1e-6);
      if (m.ambiguous) review.push(`${q}: separator could be read two ways`);
      return check(q, m.ok);
    }
    if (k.kind === 'order') {
      const list = (Array.isArray(v) ? v.map(asText) : asText(v).split(/[,;\n]|\s+-\s+|→|<|>/)).map(s => norm(s).replace(/^\d+[.)]\s*/, '')).filter(Boolean);
      return check(q, list.length === k.value.length && list.every((s, i) => s === norm(k.value[i])));
    }
    return check(q, false);
  });
  const evidence = ['s3', 's8'].map(q => {
    const ok = content.find(c => c.q === q).ok && key[q].sources.some(src => cites(answers?.[q]).includes(src) || norm(answers?.[q]?.answer).toUpperCase().includes(src));
    return check(q, ok);
  });
  const reply = t => asText(t && typeof t === 'object' && !Array.isArray(t) ? t.answer : t).normalize('NFC');
  const r1t = reply(answers?.r1), r1n = r1t.toLowerCase();
  const register = key.r1.register === 'du' ? has(DU, r1n) && !has(NI, r1n) : has(NI, r1n) && !has(DU, r1n);
  const r1ok = Boolean(r1t) && register && parseDate(r1n, key.year) === key.r1.date && words(r1t) <= key.r1.maxWords && swedishEnough(r1n);
  if (r1t && !r1ok && register && swedishEnough(r1n) && parseDate(r1n, key.year) === null) review.push('r1: date not recognized; check by hand');
  const r2t = reply(answers?.r2), r2n = r2t.toLowerCase();
  const r2ok = Boolean(r2t) && swedishEnough(r2n) && key.r2.sources.some(src => r2t.toUpperCase().includes(src));
  const replies = [check('r1', r1ok, { register }), check('r2', r2ok)];
  const parts = {
    content: round(6 * content.filter(c => c.ok).length / content.length),
    evidence: round(0.5 * evidence.filter(c => c.ok).length),
    replies: round(0.5 * replies.filter(c => c.ok).length)
  };
  return { points: round(parts.content + parts.evidence + parts.replies), max: 8, parts, items: [...content, ...replies], evidence, review };
}
