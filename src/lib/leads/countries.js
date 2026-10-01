// ISO 3166-1 alpha-2 code, display name, DuckDuckGo region code.
const COUNTRIES = [
  ['MY', 'Malaysia', 'my-en'], ['SG', 'Singapore', 'sg-en'], ['ID', 'Indonesia', 'id-en'], ['TH', 'Thailand', 'th-en'],
  ['VN', 'Vietnam', 'vn-en'], ['PH', 'Philippines', 'ph-en'], ['CN', 'China', 'cn-zh'], ['HK', 'Hong Kong', 'hk-tzh'],
  ['TW', 'Taiwan', 'tw-tzh'], ['JP', 'Japan', 'jp-jp'], ['KR', 'South Korea', 'kr-kr'], ['IN', 'India', 'in-en'],
  ['PK', 'Pakistan', 'pk-en'], ['BD', 'Bangladesh', 'wt-wt'], ['LK', 'Sri Lanka', 'wt-wt'], ['AU', 'Australia', 'au-en'],
  ['NZ', 'New Zealand', 'nz-en'], ['AE', 'United Arab Emirates', 'xa-en'], ['SA', 'Saudi Arabia', 'xa-en'], ['QA', 'Qatar', 'xa-en'],
  ['TR', 'Turkey', 'tr-tr'], ['IL', 'Israel', 'il-en'], ['EG', 'Egypt', 'xa-en'], ['ZA', 'South Africa', 'za-en'],
  ['NG', 'Nigeria', 'wt-wt'], ['KE', 'Kenya', 'wt-wt'], ['GB', 'United Kingdom', 'uk-en'], ['IE', 'Ireland', 'ie-en'],
  ['DE', 'Germany', 'de-de'], ['FR', 'France', 'fr-fr'], ['ES', 'Spain', 'es-es'], ['IT', 'Italy', 'it-it'],
  ['NL', 'Netherlands', 'nl-nl'], ['BE', 'Belgium', 'be-fr'], ['CH', 'Switzerland', 'ch-de'], ['AT', 'Austria', 'at-de'],
  ['SE', 'Sweden', 'se-sv'], ['NO', 'Norway', 'no-no'], ['DK', 'Denmark', 'dk-da'], ['FI', 'Finland', 'fi-fi'],
  ['PL', 'Poland', 'pl-pl'], ['PT', 'Portugal', 'pt-pt'], ['GR', 'Greece', 'gr-gr'], ['CZ', 'Czech Republic', 'cz-cs'],
  ['RO', 'Romania', 'ro-ro'], ['HU', 'Hungary', 'hu-hu'], ['US', 'United States', 'us-en'], ['CA', 'Canada', 'ca-en'],
  ['MX', 'Mexico', 'mx-es'], ['BR', 'Brazil', 'br-pt'], ['AR', 'Argentina', 'ar-es'], ['CL', 'Chile', 'cl-es'],
  ['CO', 'Colombia', 'co-es'], ['PE', 'Peru', 'pe-es'],
].map(([code, name, region]) => ({ code, name, region }));

const INDUSTRIES = [
  'Accounting', 'Advertising & Marketing', 'Agriculture', 'Architecture', 'Automotive', 'Banking & Finance',
  'Construction', 'Consulting', 'E-commerce', 'Education & Training', 'Energy & Utilities', 'Engineering',
  'Food & Beverage', 'Healthcare & Medical', 'Hospitality & Hotels', 'Human Resources & Recruitment',
  'Information Technology', 'Insurance', 'Investment & Asset Management', 'Legal Services', 'Logistics & Shipping',
  'Manufacturing', 'Media & Publishing', 'Non-profit', 'Oil & Gas', 'Pharmaceuticals', 'Real Estate',
  'Retail', 'Software & SaaS', 'Telecommunications', 'Travel & Tourism', 'Wholesale & Distribution',
];

const byCode = (code) => COUNTRIES.find((c) => c.code === String(code).toUpperCase());
const countryName = (v) => byCode(v)?.name || v;

module.exports = { COUNTRIES, INDUSTRIES, byCode, countryName };
