/**
 * Spelling & Grammar Analyzer
 * Detects common misspellings in visible page text content.
 * Uses a built-in dictionary of frequently misspelled words.
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage } from '../../types';

// Top 200+ commonly misspelled words (word → correct spelling)
const COMMON_MISSPELLINGS: Record<string, string> = {
  // Double letters
  accomodate: 'accommodate',
  accomodation: 'accommodation',
  occurence: 'occurrence',
  occured: 'occurred',
  occuring: 'occurring',
  refered: 'referred',
  refering: 'referring',
  commited: 'committed',
  commiting: 'committing',
  begining: 'beginning',
  embarass: 'embarrass',
  embarassing: 'embarrassing',
  millenium: 'millennium',
  millenia: 'millennia',
  neccessary: 'necessary',
  necesary: 'necessary',
  succesful: 'successful',
  successfull: 'successful',
  posession: 'possession',
  proffesional: 'professional',
  profesional: 'professional',
  ocassion: 'occasion',
  ocassionally: 'occasionally',
  dissapoint: 'disappoint',
  dissappoint: 'disappoint',
  recomend: 'recommend',
  reccomend: 'recommend',
  tommorrow: 'tomorrow',
  tommorow: 'tomorrow',
  untill: 'until',

  // ie/ei confusion
  acheive: 'achieve',
  acheiving: 'achieving',
  beleive: 'believe',
  recieve: 'receive',
  reciept: 'receipt',
  wierd: 'weird',
  freind: 'friend',
  foriegn: 'foreign',
  seize: 'seize',

  // Silent letters and unusual spelling
  definately: 'definitely',
  definatly: 'definitely',
  seperate: 'separate',
  seperately: 'separately',
  calender: 'calendar',
  goverment: 'government',
  govermental: 'governmental',
  enviroment: 'environment',
  enviromental: 'environmental',
  flourescent: 'fluorescent',
  grammer: 'grammar',
  grammaticaly: 'grammatically',
  independant: 'independent',
  independance: 'independence',
  maintainance: 'maintenance',
  maintenence: 'maintenance',
  noticable: 'noticeable',
  persistant: 'persistent',
  privledge: 'privilege',
  priviledge: 'privilege',
  publically: 'publicly',
  relevent: 'relevant',
  rythm: 'rhythm',

  // Common web/tech misspellings
  accesible: 'accessible',
  accessability: 'accessibility',
  analisis: 'analysis',
  compatability: 'compatibility',
  configuraton: 'configuration',
  customise: 'customize', // Not a misspelling in UK English, but flagging for awareness
  functonality: 'functionality',
  managment: 'management',
  performace: 'performance',
  optimze: 'optimize',
  responce: 'response',
  responsivness: 'responsiveness',
  scaleable: 'scalable',

  // Common English misspellings
  absense: 'absence',
  agressive: 'aggressive',
  apparantly: 'apparently',
  arguement: 'argument',
  awfull: 'awful',
  basicly: 'basically',
  beautifull: 'beautiful',
  buisness: 'business',
  catagory: 'category',
  changeable: 'changeable',
  collegue: 'colleague',
  colum: 'column',
  comittee: 'committee',
  comparision: 'comparison',
  concious: 'conscious',
  curiousity: 'curiosity',
  decission: 'decision',
  develope: 'develop',
  dilemna: 'dilemma',
  disipline: 'discipline',
  excercise: 'exercise',
  existance: 'existence',
  experiance: 'experience',
  explaination: 'explanation',
  familar: 'familiar',
  finaly: 'finally',
  gaurante: 'guarantee',
  guidence: 'guidance',
  harrass: 'harass',
  hieght: 'height',
  humourous: 'humorous',
  immediatly: 'immediately',
  incidently: 'incidentally',
  knowlege: 'knowledge',
  liason: 'liaison',
  liesure: 'leisure',
  lightening: 'lightning',
  manuever: 'maneuver',
  medeval: 'medieval',
  memento: 'memento',
  minature: 'miniature',
  miscellanous: 'miscellaneous',
  mischevious: 'mischievous',
  naturaly: 'naturally',
  neccessity: 'necessity',
  occassion: 'occasion',
  paralel: 'parallel',
  parliment: 'parliament',
  particulaly: 'particularly',
  passtime: 'pastime',
  percieve: 'perceive',
  persue: 'pursue',
  plagarism: 'plagiarism',
  potatos: 'potatoes',
  preceed: 'precede',
  privelege: 'privilege',
  pronounciation: 'pronunciation',
  que: 'queue',
  questionaire: 'questionnaire',
  readible: 'readable',
  realy: 'really',
  refrence: 'reference',
  religous: 'religious',
  recieved: 'received',
  repitition: 'repetition',
  restuarant: 'restaurant',
  shedule: 'schedule',
  sieze: 'seize',
  similer: 'similar',
  sincerly: 'sincerely',
  speach: 'speech',
  strenght: 'strength',
  suprise: 'surprise',
  temperture: 'temperature',
  tendancy: 'tendency',
  thier: 'their',
  threshhold: 'threshold',
  tounge: 'tongue',
  truely: 'truly',
  tyrany: 'tyranny',
  underate: 'underrate',
  unfortunatly: 'unfortunately',
  usefull: 'useful',
  vaccum: 'vacuum',
  vegatable: 'vegetable',
  vehical: 'vehicle',
  visable: 'visible',
  wether: 'whether',
  writting: 'writing',
};

class SpellingGrammarAnalyzer {
  static async analyze(chromePage: ChromePage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      totalWords: number;
      misspellings: { word: string; correction: string; count: number }[];
      totalMisspellings: number;
    } = {
      totalWords: 0,
      misspellings: [],
      totalMisspellings: 0,
    };

    try {
      // Extract visible text from the page
      const pageText = await chromePage.evaluate(() => {
        // Get visible text content, excluding scripts, styles, and hidden elements
        const excludeSelectors = 'script, style, noscript, code, pre, [aria-hidden="true"]';
        const bodyClone = document.body.cloneNode(true) as HTMLElement;

        // Remove excluded elements
        bodyClone.querySelectorAll(excludeSelectors).forEach((el) => el.remove());

        return bodyClone.textContent || '';
      });

      // Tokenize into words
      const words = pageText
        .toLowerCase()
        .replace(/[^a-z\s'-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2);

      info.totalWords = words.length;

      // Check against misspelling dictionary
      const misspellingCounts: Record<string, { correction: string; count: number }> = {};

      for (const word of words) {
        const correction = COMMON_MISSPELLINGS[word];
        if (correction) {
          if (!misspellingCounts[word]) {
            misspellingCounts[word] = { correction, count: 0 };
          }
          misspellingCounts[word].count++;
        }
      }

      // Sort by count descending
      info.misspellings = Object.entries(misspellingCounts)
        .map(([word, data]) => ({ word, correction: data.correction, count: data.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      info.totalMisspellings = Object.values(misspellingCounts).reduce(
        (sum, v) => sum + v.count,
        0,
      );
    } catch {
      return { issues, warnings, info };
    }

    if (info.misspellings.length > 0) {
      const examples = info.misspellings
        .slice(0, 5)
        .map((m) => `"${m.word}" → "${m.correction}"${m.count > 1 ? ` (${m.count}x)` : ''}`)
        .join(', ');

      const severity =
        info.totalMisspellings > 10 ? SEVERITY.MEDIUM : SEVERITY.LOW;

      issues.push({
        message: `Spelling errors detected (${info.totalMisspellings} instances)`,
        detail: `Found ${info.misspellings.length} unique misspelled word(s) across ${info.totalWords} words: ${examples}. Spelling errors can reduce trust and hurt E-E-A-T signals.`,
        severity,
      });
    }

    return { issues, warnings, info };
  }
}

export { SpellingGrammarAnalyzer };
