// parse.js — fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (gfm on, breaks off, pedantic off, async off).
//
// Approach: the same grammar as marked (same block/inline rules, same
// edge-case handling), but rendered directly to HTML in a single pass — no
// intermediate token tree, no per-token regex dispatch loop. Block parsing
// dispatches on the first characters of a line; inline parsing scans for
// the next special character and only runs the relevant tokenizer there.
//
// No imports, no dependencies, no network, no clock reads, deterministic.

/* ------------------------------------------------------------------ */
/* Grammar construction (the `edit` helper builds the same regexes    */
/* marked builds from its rule fragments).                            */
/* ------------------------------------------------------------------ */

function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace(name, val) {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex() {
      return new RegExp(source, opt);
    },
  };
  return obj;
}

const supportsLookbehind = (() => {
  try { return !!new RegExp('(?<=1)(?<!1)'); } catch { return false; }
})();

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

/* ------------------------- block grammar ------------------------- */

const newline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheadingGfm = edit(lheadingCore)
  .replace(/bull/g, bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockText = /^[^\n]+/;
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bullet)
  .getRegex();
const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const html = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();
const gfmTable = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();
const paragraphGfm = edit(_paragraph)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTable)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();
const blockquoteParagraph = edit(_paragraph)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();
const blockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraph)
  .getRegex();

/* ------------------------- inline grammar ------------------------ */

const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
const punctuationRe = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace).getRegex();
const _punctuationGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const _punctuationOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;
const blockSkipRe = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', supportsLookbehind ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();
const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelim = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();
const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter
const emStrongRDelimAst = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpaceGfmStrongEm)
  .replace(/punctSpace/g, _punctuationOrSpaceGfmStrongEm)
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();
const emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();
const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();
const delRDelimCore =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter
const delRDelim = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();
const anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();
const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();
const autolinkRe = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();
const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const tagRe = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();
const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();
const linkRe = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const reflinkRe = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();
const nolinkRe = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();
const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();
const reflinkSearchRe = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();
const _caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _extendedEmail)
  .getRegex();
const urlRe = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _extendedEmailProtocol)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const _backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const inlineTextRe = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', supportsLookbehind ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text for HTML output. encode=true escapes & < > " ' unconditionally
// (code spans, code blocks, autolink text); encode=false leaves a `&` that
// starts a valid entity/numeric reference alone.
function escapeHtml(html, encode) {
  if (encode) {
    if (!other.escapeTest.test(html)) return html;
    return html.replace(other.escapeReplace, (ch) => ESC[ch]);
  }
  if (!other.escapeTestNoEncode.test(html)) return html;
  return html.replace(other.escapeReplaceNoEncode, (ch) => ESC[ch]);
}

function decodeNumericRefs(text) {
  if (!other.numericCharacterReference.test(text)) return text;
  return text.replace(other.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href);
  } catch {
    return null;
  }
  // encodeURI only produces %25 from a literal '%' in the input
  if (href.indexOf('%25') !== -1) href = href.replace(other.percentDecode, '%');
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(other.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(other.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  }
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && other.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(other.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(other.beginningSpace);
    if (mi === null) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

/* ------------------------------------------------------------------ */
/* Inline parsing — direct HTML rendering                             */
/*                                                                    */
/* Faithful port of marked 18.1.3's inline lexing/rendering, but      */
/* rendering directly to HTML strings instead of building a token     */
/* tree first. Tokenizer order matches marked's #tokenizeInlines:     */
/* escape, tag, link, reflink, emStrong, codespan, br, del,           */
/* autolink, url, text.                                               */
/* ------------------------------------------------------------------ */

// Per-parse shared state (reset in parse()).
const S = {
  links: null,           // Object.create(null): normalized label -> {href, title}
  inLink: false,
  inRawBlock: false,
  linkEmitted: false,
  linkParenPossible: true,
  linkCount: 0,         // number of link reference definitions registered
};

const IS_WORD = /[A-Za-z0-9_]/;
// character-class lookup tables (a per-character regex test is far slower
// than a table lookup in the hot text-scanning loop)
const LOCAL_T = new Uint8Array(128);   // [A-Za-z0-9.!#$%&'*+/=?`{|}~-]
const EMAIL_T = new Uint8Array(128);   // [A-Za-z0-9._+-]  (url() email set)
const STOP_T = new Uint8Array(128);    // characters that end a plain-text run
{
  const local = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?`{|}~-";
  for (let i = 0; i < local.length; i++) LOCAL_T[local.charCodeAt(i)] = 1;
  const email = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+-';
  for (let i = 0; i < email.length; i++) EMAIL_T[email.charCodeAt(i)] = 1;
  const stop = '\\<[!`*~_';
  for (let i = 0; i < stop.length; i++) STOP_T[stop.charCodeAt(i)] = 1;
}

// Case-insensitive http(s):// or ftp:// at position j (marked's protocol
// rule is case-insensitive: Https:// is an autolink).
function protoAt(src, j) {
  const a = src.charCodeAt(j) | 32;
  if (a === 104) { // h
    if ((src.charCodeAt(j + 1) | 32) !== 116) return false; // t
    if ((src.charCodeAt(j + 2) | 32) !== 116) return false; // t
    if ((src.charCodeAt(j + 3) | 32) !== 112) return false; // p
    let k = j + 4;
    if ((src.charCodeAt(k) | 32) === 115) k++; // s
    return src[k] === ':' && src[k + 1] === '/' && src[k + 2] === '/';
  }
  if (a === 102) { // f
    if ((src.charCodeAt(j + 1) | 32) !== 116) return false; // t
    if ((src.charCodeAt(j + 2) | 32) !== 112) return false; // p
    return src[j + 3] === ':' && src[j + 4] === '/' && src[j + 5] === '/';
  }
  return false;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = inlineCodeRe.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = tagRe.exec(tokenSrc) || autolinkRe.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function linkInText(text) {
  if (!text.includes('[')) return false;
  blockSkipRe.lastIndex = 0;
  for (const match of text.matchAll(blockSkipRe)) {
    if (linkRe.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  reflinkSearchRe.lastIndex = 0;
  for (const match of text.matchAll(reflinkSearchRe)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code, html and escapes so emStrong/del do not see their
// delimiters inside them. Length-preserving, like marked's #maskSrc.
function maskSrc(src) {
  let maskedSrc = src;
  // reflink masking only matters when a definition exists
  if (S.linkCount > 0 && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text)) {
          return '[' + text.replace(reflinkSearchRe, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearchRe, maskReflink);
  }
  // escape masking: masks backslash escapes and the inner backticks of
  // code spans (so the block-skip step below matches a code span's outer
  // backtick run, not an inner one) — it matters when a backslash or a
  // backtick is present
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  // link / code / html masking only matters when one of those can start
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(blockSkipRe, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

// Scan a plain-text chunk starting at i in src. Stops at the same points
// marked's inline text rule stops at. If force is set, the first character
// is consumed unconditionally (it failed to tokenize, so it is text — this
// merges it into the following text chunk, exactly like marked merging
// consecutive text tokens). Returns the new index.
//
// The next special character is found with a C-level regex search; the
// url/email/www triggers inside the span are found with indexOf.
const SPECIAL_RE = /[\\<[!`*~_]/;
const PROTO_RE = /https?:\/\/|ftp:\/\/|mailto:|xmpp:/i;
const HARDBREAK_RE = / {2,}\n/;
// email: an '@' inside the span; the text ends at the local-part run start
function emailCut(src, j, stop) {
  const span = src.slice(j, stop);
  const at = span.indexOf('@');
  if (at === -1) return stop;
  let rs = j + at;
  while (rs > j) {
    const pc = src.charCodeAt(rs - 1);
    if (pc >= 128 || !LOCAL_T[pc]) break;
    rs--;
  }
  return rs >= j ? rs : stop;
}

// www. : only when preceded by start, whitespace, *, _, ~ or (
function wwwCut(src, j, stop) {
  const span = src.slice(j, stop);
  let w = span.indexOf('www.');
  while (w !== -1) {
    const wi = j + w;
    if (wi >= stop) break;
    const p = src[wi - 1];
    if (wi === 0 || p === ' ' || p === '\t' || p === '\n' || p === '\r' || p === '\f'
      || p === '\v' || p === '*' || p === '_' || p === '~' || p === '(') return wi;
    w = span.indexOf('www.', w + 1);
  }
  return stop;
}

// protocols (case-insensitive) and hard breaks inside the span;
// both need a ':' / a double space, so skip the regex when absent
function protoBreakCut(src, j, stop) {
  const span = src.slice(j, stop);
  if (span.indexOf(':') !== -1) {
    const pm = PROTO_RE.exec(span);
    if (pm) stop = Math.min(stop, j + pm.index);
  }
  if (span.indexOf('  ') !== -1 && span.indexOf('\n') !== -1) {
    const hm = HARDBREAK_RE.exec(span);
    if (hm) stop = Math.min(stop, j + hm.index);
  }
  return stop;
}

function scanText(src, i, force = false) {
  const n = src.length;
  // a failed tokenizer's first character is text; marked's text rule takes
  // a whole backtick or tilde run as its first characters
  let j = i;
  if (force) {
    if (src[i] === '`' || src[i] === '~') {
      const ch = src[i];
      while (j < n && src[j] === ch) j++;
    } else {
      j = i + 1;
    }
  }
  if (j >= n) return j;
  // next special character (or end of string)
  const m = SPECIAL_RE.exec(src.slice(j));
  let stop = m ? j + m.index : n;
  if (stop === j) return stop; // no plain text before the special char
  // All trigger searches below are bounded to the span [j, stop): searching
  // the whole remainder for '@' / 'www.' was O(n) per text chunk.
  stop = emailCut(src, j, stop);
  stop = wwwCut(src, j, stop);
  if (stop > j) stop = protoBreakCut(src, j, stop);
  return stop;
}

// Could a URL / bare email start at i? Mirrors scanText's stop points.
// The protocol checks must not short-circuit the email check: 'f', 'h',
// 'm', 'x' and 'w' are also email local-part characters.
function urlTriggerAt(src, i) {
  const c = src[i];
  if (c === 'w' && src.startsWith('www.', i)) return true;
  if ((c === 'h' || c === 'H' || c === 'f' || c === 'F') && protoAt(src, i)) return true;
  if ((c === 'm' || c === 'x') && (src.startsWith('mailto:', i) || src.startsWith('xmpp:', i))) return true;
  return startsEmailAt(src, i);
}

// email: the url() rule's local part is the narrow set [A-Za-z0-9._+-]
// (it includes '_', so a.b-c_d@a.b is one address)
function startsEmailAt(src, i) {
  const code = src.charCodeAt(i);
  if (code >= 128 || !EMAIL_T[code]) return false;
  if (i > 0) {
    const prev = src.charCodeAt(i - 1);
    if (prev < 128 && EMAIL_T[prev]) return false;
  }
  let k = i;
  const n = src.length;
  while (k < n) {
    const kc = src.charCodeAt(k);
    if (kc >= 128 || !EMAIL_T[kc]) break;
    k++;
  }
  return src[k] === '@';
}

function pushText(out, chunk, plain) {
  if (plain) {
    // plain text only decodes numeric character references
    out.push(chunk.includes('&#') ? decodeNumericRefs(chunk) : chunk);
    return;
  }
  if (S.inRawBlock) {
    out.push(chunk);
    return;
  }
  const needsEscape = chunk.includes('&') || chunk.includes('<') || chunk.includes('>')
    || chunk.includes('"') || chunk.includes("'");
  if (!needsEscape) {
    // fast path: most text has no entity or markup character at all
    out.push(chunk);
    return;
  }
  if (!chunk.includes('&#')) {
    // without a numeric reference, escaping alone handles bare '&' and
    // leaves named entities untouched
    out.push(escapeHtml(chunk));
    return;
  }
  out.push(escapeHtml(decodeNumericRefs(chunk)));
}

// ASCII alphanumeric (fast path for the unicode check below)
function isAlnumAscii(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isAlnumChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return isAlnumAscii(code);
  return other.unicodeAlphaNumeric.test(ch);
}
// ASCII punctuation / symbol / whitespace (fast path for punctuationRe)
const PUNCT_T = new Uint8Array(128);
{
  const punct = ' \t\n\r\f\v!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  for (let i = 0; i < punct.length; i++) PUNCT_T[punct.charCodeAt(i)] = 1;
}
function isPunctOrSpace(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return PUNCT_T[code] === 1;
  return punctuationRe.test(ch);
}
// code-unit length of the first code point of s (1, or 2 for astral)
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  return (c >= 0xD800 && c <= 0xDBFF) ? 2 : 1;
}

// Emphasis / strong — same decisions as marked's Tokenizer.emStrong,
// reorganized: the delimiter-run context is gathered first, then a
// dedicated scan walks the right-delimiter candidates and settles the
// open/close balance. src starts at the opening run; maskedSrc is the
// masked source of the whole inline run. Returns {html, len} or null.
function emStrong(src, maskedSrc, prevChar, plain) {
  const left = emStrongLDelim.exec(src);
  if (!left) return null;
  const followedBy = left[1] || left[2] || left[3] || left[4];
  if (!followedBy) return null;

  const mark = left[0][0];
  const touchesPrev = prevChar === mark;

  // Where this run starts in the full masked source, and the character
  // (if any) directly before it — a low surrogate needs its pair.
  const runOffset = maskedSrc.length - src.length;
  let runBegin = runOffset;
  while (runBegin > 0 && maskedSrc[runBegin - 1] === mark) runBegin--;
  let before = '';
  if (runBegin > 0) {
    const tailCode = maskedSrc.charCodeAt(runBegin - 1);
    before = (tailCode >= 0xDC00 && tailCode <= 0xDFFF && runBegin >= 2)
      ? maskedSrc.slice(runBegin - 2, runBegin)
      : maskedSrc[runBegin - 1];
  }
  const beforeIsPunct = before === '*' || before === '_' || isPunctOrSpace(before);
  if (runBegin < runOffset) prevChar = before;
  const prevIsPunct = runBegin < runOffset ? beforeIsPunct : isPunctOrSpace(prevChar);

  // An underscore run between alphanumerics can never open.
  if (left[4] && isAlnumChar(prevChar)) return null;

  // A punctuation character after the run only opens when the run is at
  // the start or follows punctuation/whitespace (left-flanking rule).
  const afterPunct = left[1] || left[3] || '';
  if (afterPunct && prevChar && !prevIsPunct) return null;

  let openLen = 0;
  while (openLen < left[0].length && left[0][openLen] === mark) openLen++;
  if (mark !== '*' && mark !== '_') return null;

  // Delimiters still waiting for a closer, plus those set aside by the
  // CommonMark rules 9-10 length check.
  let owed = openLen;
  let held = 0;
  const runLen = runOffset - runBegin + openLen;
  const openerCanClose = !!before.trim()
    && (!!afterPunct || (mark === '*' && !beforeIsPunct));
  const closerRe = mark === '*' ? emStrongRDelimAst : emStrongRDelimUnd;
  const searchable = maskedSrc.slice(-src.length + openLen);
  closerRe.lastIndex = 0;

  let hit;
  while ((hit = closerRe.exec(searchable)) !== null) {
    const closeMark = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
    if (!closeMark) continue; // skip a lone * inside __abc*abc__
    const closeLen = closeMark.length;

    if (hit[3] || hit[4]) { // another left delimiter: it needs closing too
      owed += closeLen;
      continue;
    }
    if (hit[5] || hit[6] || openerCanClose) {
      if (touchesPrev && (hit[5] || hit[6])) break;
      if (runLen % 3 && !((runLen + closeLen) % 3)) {
        held += closeLen; // rules 9-10: hold these for a later closer
        continue;
      }
    }

    owed -= closeLen;
    if (owed > 0) continue; // not enough closing delimiters yet

    // Trim the closer to what is actually needed: *a*** -> *a*.
    const useLen = Math.min(closeLen, closeLen + owed + held);
    const headLen = firstCpLen(hit[0]);
    const raw = src.slice(0, openLen + hit.index + headLen + useLen);
    if (Math.min(openLen, useLen) % 2) {
      const inner = inlineRun(raw.slice(1, -1), plain);
      return { html: plain ? inner : `<em>${inner}</em>`, len: raw.length };
    }
    const inner = inlineRun(raw.slice(2, -2), plain);
    return { html: plain ? inner : `<strong>${inner}</strong>`, len: raw.length };
  }
  return null;
}

// Strikethrough — same decisions as marked's Tokenizer.del, reorganized
// to mirror the emphasis scan: gather the opening run, then walk the
// right-delimiter candidates until the balance settles.
function del(src, maskedSrc, prevChar, plain) {
  const left = delLDelim.exec(src);
  if (!left) return null;
  const afterPunct = left[1] || '';
  if (afterPunct && prevChar && !isPunctOrSpace(prevChar)) return null;

  let openLen = 0;
  while (openLen < left[0].length && left[0][openLen] === '~') openLen++;
  let owed = openLen;
  const searchable = maskedSrc.slice(-src.length + openLen);
  delRDelim.lastIndex = 0;

  let hit;
  while ((hit = delRDelim.exec(searchable)) !== null) {
    const closeMark = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
    if (!closeMark) continue;
    const closeLen = closeMark.length;
    if (closeLen !== openLen) continue; // runs must match in length
    if (hit[3] || hit[4]) { // another left delimiter: it needs closing too
      owed += closeLen;
      continue;
    }
    owed -= closeLen;
    if (owed > 0) continue;
    const useLen = Math.min(closeLen, closeLen + owed);
    const headLen = firstCpLen(hit[0]);
    const raw = src.slice(0, openLen + hit.index + headLen + useLen);
    const inner = inlineRun(raw.slice(openLen, -openLen), plain);
    return { html: plain ? inner : `<del>${inner}</del>`, len: raw.length };
  }
  return null;
}

// Inline link / image — port of marked's Tokenizer.link + outputLink.
// Returns {html, len} or null (not a link).
function tryLink(src, i, plain) {
  if (S.linkParenPossible === false) return null;
  const cap = linkRe.exec(src.slice(i));
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src.slice(i), cap[1], labelStart)) return null;

  const trimmedUrl = cap[2].trim();
  if (other.startAngleBracket.test(trimmedUrl)) {
    if (!other.endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;

  let href = cap[2];
  let title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (other.startAngleBracket.test(href)) {
    href = href.slice(1, -1);
  }
  return outputLink(cap, {
    href: href ? href.replace(anyPunctuation, '$1') : href,
    title: title ? title.replace(anyPunctuation, '$1') : title,
  }, cap[0], plain);
}

// Reference link / image — port of marked's Tokenizer.reflink.
// Returns {html, len}; for an unresolved reference the html is just the
// first character and len is 1 (caller re-scans from there).
function tryReflink(src, i, plain) {
  let cap = reflinkRe.exec(src.slice(i)) || nolinkRe.exec(src.slice(i));
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src.slice(i), cap[1], labelStart)) return null;
  const link = S.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    return { html: ch, len: 1, unresolved: true };
  }
  return outputLink(cap, link, cap[0], plain);
}

// Shared link/image rendering — port of marked's outputLink.
// Returns {html, len} or null when the label already holds a link
// (caller falls through to text).
function outputLink(cap, link, raw, plain) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const innerHtml = inlineRun(text, isImage ? true : plain);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;

  if (!isImage) {
    if (textHasLink) {
      S.inRawBlock = outerInRawBlock;
      return null;
    }
    S.linkEmitted = true;
  }

  if (isImage) {
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) {
      if (plain) return { html: innerHtml, len: raw.length };
      return { html: escapeHtml(innerHtml), len: raw.length };
    }
    if (plain) return { html: innerHtml, len: raw.length };
    let out = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(innerHtml)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    out += '>';
    return { html: out, len: raw.length };
  }

  // the label was tokenized exactly once above (innerHtml); rendering it
  // again would re-tokenize with different inLink state
  const parsedText = innerHtml;
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: parsedText, len: raw.length };
  if (plain) return { html: parsedText, len: raw.length };
  let out = '<a href="' + escapeHtml(cleanHref) + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  out += '>' + parsedText + '</a>';
  return { html: out, len: raw.length };
}

// Autolink <...> — port of marked's Tokenizer.autolink.
function tryAutolink(src, i, plain) {
  const cap = autolinkRe.exec(src.slice(i));
  if (!cap) return null;
  const text = cap[1];
  let href;
  if (cap[2] === '@') href = 'mailto:' + text;
  else href = text;
  const clean = cleanUrl(href);
  if (clean === null) return null;
  if (plain) return { html: text, len: cap[0].length };
  return { html: '<a href="' + escapeHtml(clean, true) + '">' + escapeHtml(text, true) + '</a>', len: cap[0].length };
}

// GFM extended autolink — port of marked's Tokenizer.url.
function tryUrl(src, i, plain) {
  const cap = urlRe.exec(src.slice(i));
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = _backpedalRe.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    if (cap[1] === 'www.') href = 'http://' + cap[0];
    else href = cap[0];
  }
  const clean = cleanUrl(href);
  if (clean === null) return null;
  if (plain) return { html: text, len: cap[0].length };
  return { html: '<a href="' + escapeHtml(clean, true) + '">' + escapeHtml(text, true) + '</a>', len: cap[0].length };
}

// Main inline loop. Renders src to HTML (plain=true: plain text, for
// image alt attributes). Re-entrant: link labels, emphasis and
// strikethrough recurse through here.
function inlineRun(src, plain = false) {
  const prevLinkParenPossible = S.linkParenPossible;
  // tryLink is only ever called when the run contains '[', so skip the
  // ')' scan for runs that cannot contain a link at all
  if (prevLinkParenPossible && src.includes('[')) {
    S.linkParenPossible = src.includes(')');
  } else if (!prevLinkParenPossible) {
    S.linkParenPossible = false;
  }
  try {
    return inlineRunInner(src, plain);
  } finally {
    S.linkParenPossible = prevLinkParenPossible;
  }
}

// One inline construct attempt. Each helper pushes its HTML into `out`
// and returns how many source characters it consumed, or 0 when the
// character at `i` is not its construct after all. tryBracketAt returns
// {first} instead for an unresolved reference: only its first character
// is text, and the loop re-scans after it.
function tryEscapeAt(src, i, plain, out) {
  const cap = escapeRe.exec(src.slice(i));
  if (cap) {
    const c = cap[1];
    out.push(plain ? c : escapeHtml(c));
    return 2;
  }
  if (src[i + 1] === '\n') {
    const m = brRe.exec(src.slice(i));
    if (m) {
      if (!plain) out.push('<br>');
      return m[0].length;
    }
  }
  return 0;
}

function tryAngleAt(src, i, plain, out) {
  const tagCap = tagRe.exec(src.slice(i));
  if (tagCap) {
    const tag = tagCap[0];
    const opensLink = other.startATag.test(tag);
    const closesLink = other.endATag.test(tag);
    if (opensLink && !S.inLink) S.inLink = true;
    else if (closesLink && S.inLink) S.inLink = false;
    const opensRaw = other.startPreScriptTag.test(tag);
    const closesRaw = other.endPreScriptTag.test(tag);
    if (opensRaw && !S.inRawBlock) S.inRawBlock = true;
    else if (closesRaw && S.inRawBlock) S.inRawBlock = false;
    out.push(tag);
    return tag.length;
  }
  const auto = tryAutolink(src, i, plain);
  if (auto) {
    out.push(auto.html);
    return auto.len;
  }
  return 0;
}

function tryBracketAt(src, i, plain, out) {
  if (src[i] === '!' && src[i + 1] !== '[') return 0;
  const res = tryLink(src, i, plain) || tryReflink(src, i, plain);
  if (!res) return 0;
  if (res.unresolved) return { first: res.html };
  out.push(res.html);
  return res.len;
}

function tryEmphasisAt(src, i, maskedSrc, prevChar, plain, out) {
  const ch = src[i];
  if (ch === '_' && isAlnumChar(prevChar)) {
    // '_' between alphanumerics can never open emphasis (CommonMark):
    // emStrong returns null when the char after the run is a non-space,
    // non-'_' char and the previous char is alphanumeric. Skip the call.
    let k = i;
    while (src[k] === '_') k++;
    const nx = src[k];
    const blocked = nx !== undefined && nx !== ' ' && nx !== '\t' && nx !== '\n'
      && nx !== '\r' && nx !== '\f' && nx !== '\v';
    if (blocked) return 0;
  }
  const res = emStrong(src.slice(i), maskedSrc, prevChar, plain);
  if (!res) return 0;
  out.push(res.html);
  return res.len;
}

function tryCodeAt(src, i, plain, out) {
  const cap = inlineCodeRe.exec(src.slice(i));
  if (!cap) return 0;
  let text = cap[2].replace(/\n/g, ' ');
  const padded = text.length > 2 && text.startsWith(' ') && text.endsWith(' ')
    && text.trim() !== '';
  if (padded) text = text.slice(1, -1);
  out.push(plain ? text : '<code>' + escapeHtml(text, true) + '</code>');
  return cap[0].length;
}

function tryBreakAt(src, i, plain, out) {
  const m = brRe.exec(src.slice(i));
  if (!m) return 0;
  if (!plain) out.push('<br>');
  return m[0].length;
}

function tryStrikeAt(src, i, maskedSrc, prevChar, plain, out) {
  const res = del(src.slice(i), maskedSrc, prevChar, plain);
  if (!res) return 0;
  out.push(res.html);
  return res.len;
}

function tryBareUrlAt(src, i, plain, out) {
  if (!S.inLink && urlTriggerAt(src, i)) {
    const u = tryUrl(src, i, plain);
    if (u) {
      out.push(u.html);
      return u.len;
    }
  }
  return 0;
}

function inlineRunInner(src, plain) {
  const out = [];
  const n = src.length;
  // Fast path: no inline construct, no url/email trigger, no hard break —
  // the whole run is one plain text chunk (common for link labels and
  // emphasis interiors). pushText handles entities and escaping.
  const hasTrigger = SPECIAL_RE.test(src) || src.includes('@') || src.includes('www.')
    || PROTO_RE.test(src) || src.includes('  \n');
  if (n > 0 && !hasTrigger) {
    pushText(out, src, plain);
    return out.join('');
  }
  let i = 0;
  let prevChar = '';
  let keepPrevChar = false;
  // masked source is local to this run (nested runs mask their own text)
  const maskedSrc = /[*_~]/.test(src) ? maskSrc(src) : src;

  while (i < n) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[i];
    let step;
    switch (ch) {
      case '\\': step = tryEscapeAt(src, i, plain, out); break;
      case '<': step = tryAngleAt(src, i, plain, out); break;
      case '[':
      case '!': step = tryBracketAt(src, i, plain, out); break;
      case '*':
      case '_': step = tryEmphasisAt(src, i, maskedSrc, prevChar, plain, out); break;
      case '`': step = tryCodeAt(src, i, plain, out); break;
      case ' ': step = tryBreakAt(src, i, plain, out); break;
      case '~': step = tryStrikeAt(src, i, maskedSrc, prevChar, plain, out); break;
      default:
        step = (ch.charCodeAt(0) < 128 && LOCAL_T[ch.charCodeAt(0)])
          ? tryBareUrlAt(src, i, plain, out)
          : 0;
    }
    if (step && typeof step === 'object') {
      // Unresolved reference: only the first character is text; the loop
      // re-scans after it with that character as the previous one.
      pushText(out, step.first, plain);
      i += 1;
      prevChar = step.first;
      keepPrevChar = true;
      continue;
    }
    if (step > 0) {
      i += step;
      prevChar = '';
      continue;
    }
    // Text chunk (first char consumed unconditionally — it failed to
    // tokenize, so it is text, merged with what follows).
    const end = scanText(src, i, true);
    const chunk = src.slice(i, end);
    pushText(out, chunk, plain);
    i += chunk.length;
    const tail = chunk[chunk.length - 1];
    if (tail !== '_') prevChar = tail;
    keepPrevChar = true;
  }
  return out.join('');
}

/* ------------------------------------------------------------------ */
/* Block parsing — port of marked 18.1.3's block lexing, producing a   */
/* lightweight node tree. Inline runs are queued in tokenization      */
/* order and rendered in a second pass, exactly like marked's          */
/* inlineQueue.                                                       */
/* ------------------------------------------------------------------ */

const LX = {
  links: null,        // same object as S.links
  inlineQueue: [],    // run objects {src, prefix, html}
  top: true,
};

function queueInline(src) {
  const run = { src, prefix: '', html: '' };
  LX.inlineQueue.push(run);
  return run;
}

// --- block tokenizers (each returns a node or null) ---

function tokSpace(src) {
  const cap = newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  return null;
}

function tokCode(src) {
  const cap = blockCode.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(other.codeRemoveIndent, '');
    return { type: 'code', raw, text };
  }
  return null;
}

function tokFences(src) {
  const cap = fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(anyPunctuation, '$1') : cap[2],
      text,
    };
  }
  return null;
}

function tokHeading(src) {
  const cap = heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (other.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || other.endingSpaceTabChar.test(trimmed)) {
        text = trimmed.trim();
      }
    }
    const node = { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text };
    node.run = queueInline(text);
    return node;
  }
  return null;
}

function tokHr(src) {
  const cap = hr.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
  return null;
}

// Collect one run of blockquote lines: lines carrying the `>` marker,
// plus any plain lines before the first marker; the run ends at the
// first plain line after a marker line.
function takeQuoteRun(lines) {
  const run = [];
  let seenMarker = false;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (other.blockquoteStart.test(line)) {
      run.push(line);
      seenMarker = true;
    } else if (!seenMarker) {
      run.push(line);
    } else {
      break;
    }
  }
  return { run, rest: lines.slice(i) };
}

// Turn the raw lines of one blockquote run into the inner text that
// gets tokenized: expand the tabs after each marker, re-indent setext
// underlines, then strip the markers.
function stripQuoteMarkers(rawText) {
  let inner = rawText.replace(other.blockquoteMarkerWhitespace,
    (whole, marker, whitespace) => marker + expandTabs(whitespace, marker.length));
  inner = inner.replace(other.blockquoteSetextReplace, '\n    $1');
  return inner.replace(other.blockquoteSetextReplace2, '');
}

function tokBlockquote(src) {
  const match = blockquoteRe.exec(src);
  if (!match) return null;
  let lines = rtrim(match[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    const { run, rest } = takeQuoteRun(lines);
    lines = rest;

    const runRaw = run.join('\n');
    const runText = stripQuoteMarkers(runRaw);
    raw = raw ? `${raw}\n${runRaw}` : runRaw;
    text = text ? `${text}\n${runText}` : runText;

    const savedTop = LX.top;
    LX.top = true;
    blockTokens(runText, tokens, true);
    LX.top = savedTop;

    if (lines.length === 0) break;

    const last = tokens.at(-1);
    const lastKind = last?.type;
    if (lastKind === 'code' || lastKind === 'heading' || lastKind === 'hr'
      || lastKind === 'html' || lastKind === 'table') {
      break;
    }
    if (lastKind === 'blockquote') {
      const joined = lines.join('\n');
      const extended = last.raw + '\n' + joined.replace(other.blockquoteSetextReplace2, '');
      const remade = tokBlockquote(extended);
      tokens[tokens.length - 1] = remade;
      const leftover = extended.substring(remade.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const taken = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
      if (taken.length > 0) raw = `${raw}\n${taken.join('\n')}`;
      text = text.substring(0, text.length - last.text.length) + remade.text;
      lines = lines.slice(taken.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
      break;
    }
    if (lastKind === 'list') {
      const extended = last.raw + '\n' + lines.join('\n');
      const remade = tokList(extended);
      tokens[tokens.length - 1] = remade;
      const grown = remade.raw.length > last.raw.length
        ? extended.slice(last.raw.length + 1, remade.raw.length).split('\n').length
        : 0;
      if (grown > 0) {
        const taken = lines.slice(0, grown).join('\n');
        raw = `${raw}\n${taken}`;
        text = `${text}\n${taken}`;
      }
      lines = lines.slice(grown);
    }
  }

  return { type: 'blockquote', raw, tokens, text };
}

// first line of a string (up to, not including, the first '\n')
function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// /^[ \t]*$/ — a line with no content
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// index of the first character that is not ' ' (-1 if none); mirrors
// String.search(/[^ ]/)
function firstNonSpace(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i < s.length ? i : -1;
}

// column of the first non-space character after expanding each tab to
// four spaces (-1 if none); mirrors s.replace(/\t/g, '    ').search(/[^ ]/)
function firstNonSpaceCol(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t') col += 4;
    else if (c === ' ') col += 1;
    else return col;
  }
  return -1;
}

// /\n[ \t]*\n[ \t]*$/ — raw ends with a double blank line
function endsWithDoubleBlankLine(raw) {
  let i = raw.length;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  return i > 0 && raw[i - 1] === '\n';
}

// first non-space character of a line, but only when the leading spaces
// fit the indent allowance the block regexes use (0..min(3, indent-1));
// '' when the line cannot match any of those regexes
function lineTriggerChar(s, maxLead) {
  let lead = 0;
  while (lead < s.length && s[lead] === ' ') lead++;
  if (lead > maxLead) return '';
  return s[lead] || '';
}

// Does this line start a block that ends a list item? The first-char
// gate keeps the (cached) block regexes off plain lines. `full` adds the
// blockquote and bullet checks, which only apply to the next line, not
// to the line being continued.
function lineBeginsBlock(line, maxLead, res, full) {
  const fc = lineTriggerChar(line, maxLead);
  if ((fc === '`' || fc === '~') && res.fence.test(line)) return true;
  if (fc === '#' && res.heading.test(line)) return true;
  if (fc === '<' && res.html.test(line)) return true;
  if (full && fc === '>' && res.quote.test(line)) return true;
  if (full && (fc === '*' || fc === '+' || fc === '-' || (fc >= '0' && fc <= '9'))
    && res.bullet.test(line)) return true;
  if ((fc === '-' || fc === '_' || fc === '*') && res.hr.test(line)) return true;
  return false;
}

// Consume the continuation lines of one list item. `st` carries the
// mutable state (remaining source, accumulated body, blank flag, current
// line) and is returned updated; a line that starts another block stays
// in `st.rest`, ending the item.
function gatherItemLines(st, indent) {
  const res = {
    fence: other.fencesBeginRegex(indent),
    heading: other.headingBeginRegex(indent),
    html: other.htmlBeginRegex(indent),
    quote: other.blockquoteBeginRegex(indent),
    bullet: other.nextBulletRegex(indent),
    hr: other.hrRegex(indent),
  };
  // the cached indent regexes only allow 0..min(3, indent-1) spaces
  const maxLead = Math.min(3, indent - 1);
  while (st.rest) {
    const rawLine = firstLineOf(st.rest);
    const nextLine = rawLine;
    const nextNoTabs = (nextLine[0] === ' ' || nextLine[0] === '\t')
      ? nextLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws))
      : nextLine;

    // end the item when the next line starts another block
    if (lineBeginsBlock(nextLine, maxLead, res, true)) break;

    if (firstNonSpace(nextNoTabs) >= indent || isBlankLine(nextLine)) {
      st.body += '\n' + nextNoTabs.slice(indent);
    } else {
      if (st.blank) break;
      if (firstNonSpaceCol(st.line) >= 4) break;
      if (lineBeginsBlock(st.line, maxLead, res, false)) break;

      const sfc = lineTriggerChar(nextLine, 3);
      const setextContinuation = (sfc === '=' || sfc === '-')
        && /^ {0,3}(?:=+|-+) *$/.test(nextLine)
        && lheadingGfm.test(`${st.line}\n${nextLine}`);
      const continuation = setextContinuation
        ? `    ${nextNoTabs.replace(/^ {0,3}/, '')}`
        : nextLine;
      st.body += '\n' + continuation;
    }

    st.blank = isBlankLine(nextLine);
    st.rest = st.rest.substring(rawLine.length + 1);
    st.line = nextNoTabs.slice(indent);
  }
  return st;
}

// Second pass over a tokenized list: place the task checkboxes, using
// the final loose/tight state of the list.
function placeTaskCheckboxes(node) {
  for (const item of node.items) {
    const firstToken = item.tokens[0];
    if (item.task && (firstToken?.type === 'text' || firstToken?.type === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      firstToken.raw = firstToken.raw.replace(other.listReplaceTask, '');
      firstToken.text = firstToken.text.replace(other.listReplaceTask, '');
      for (let i = LX.inlineQueue.length - 1; i >= 0; i--) {
        if (other.listIsTask.test(LX.inlineQueue[i].src)) {
          LX.inlineQueue[i].src = LX.inlineQueue[i].src.replace(other.listReplaceTask, '');
          break;
        }
      }

      const taskRaw = other.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        const boxHtml = '<input ' + (checked ? 'checked="" ' : '')
          + 'disabled="" type="checkbox"> ';
        item.checked = checked;
        if (node.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type)
            && item.tokens[0].run) {
            item.tokens[0].raw = taskRaw[0] + ' ' + item.tokens[0].raw;
            item.tokens[0].text = taskRaw[0] + ' ' + item.tokens[0].text;
            item.tokens[0].run.prefix = boxHtml;
          } else {
            // synthetic paragraph holding only the checkbox (not queued)
            item.tokens.unshift({
              type: 'paragraph',
              raw: taskRaw[0] + ' ',
              text: taskRaw[0] + ' ',
              run: { src: '', prefix: '', html: boxHtml },
            });
          }
        } else {
          item.tokens.unshift({ type: 'checkbox', raw: taskRaw[0] + ' ', checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
}

function tokList(src) {
  const head = list.exec(src);
  if (!head) return null;
  const whole = src;
  let rest = src;
  const consumed = () => whole.length - rest.length;
  let marker = head[1].trim();
  const ordered = marker.length > 1;

  const node = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +marker.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  marker = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;

  const itemRe = other.listItemRegex(marker);
  let trailingBlank = false;
  while (rest) {
    const cap = itemRe.exec(rest);
    if (!cap) break;
    if (hr.test(rest)) break;

    const itemStart = consumed();
    rest = rest.substring(cap[0].length);

    const first = firstLineOf(cap[2]);
    const markerWidth = cap[1].length;
    let line = (first[0] === ' ' || first[0] === '\t')
      ? first.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, markerWidth))
      : first;
    const following = firstLineOf(rest);
    let blank = isBlankLine(line);

    let indent;
    let body;
    if (blank) {
      indent = markerWidth + 1;
      body = '';
    } else {
      indent = firstNonSpace(line);
      if (indent > 4) indent = 1;
      body = line.slice(indent);
      indent += markerWidth;
    }

    let doneEarly = false;
    if (blank && isBlankLine(following)) {
      rest = rest.substring(following.length + 1);
      doneEarly = true;
    }

    if (!doneEarly) {
      const st = gatherItemLines({ rest, body, blank, line }, indent);
      rest = st.rest;
      body = st.body;
      blank = st.blank;
      line = st.line;
    }

    const raw = whole.slice(itemStart, consumed());

    if (!node.loose) {
      if (trailingBlank) {
        node.loose = true;
      } else if (endsWithDoubleBlankLine(raw)) {
        trailingBlank = true;
      }
    }

    node.items.push({
      type: 'list_item',
      raw,
      task: other.listIsTask.test(body),
      loose: false,
      text: body,
      tokens: [],
    });
  }

  const lastItem = node.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  node.raw = whole.slice(0, consumed()).trimEnd();

  // First pass: tokenize items and finalize list.loose from spacers
  for (const item of node.items) {
    LX.top = false;
    item.tokens = blockTokens(item.text, []);
    if (!node.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const splitByBlanks = spacers.length > 0
        && spacers.some((t) => other.anyLine.test(t.raw));
      node.loose = splitByBlanks;
    }
  }

  // Second pass: place task checkboxes using the final list.loose
  placeTaskCheckboxes(node);

  if (node.loose) {
    for (const item of node.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }

  return node;
}

function tokHtml(src) {
  const cap = html.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
  }
  return null;
}

function tokDef(src) {
  const cap = def.exec(src);
  if (cap) {
    if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return null;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuation, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
  return null;
}

function tokTable(src) {
  const cap = gfmTable.exec(src);
  if (!cap) return null;
  if (!other.tableDelimiter.test(cap[2])) return null;

  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];

  if (headers.length !== aligns.length) return null;

  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };

  for (const align of aligns) {
    if (other.tableAlignRight.test(align)) item.align.push('right');
    else if (other.tableAlignCenter.test(align)) item.align.push('center');
    else if (other.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }

  for (let i = 0; i < headers.length; i++) {
    const cell = { text: headers[i], header: true, align: item.align[i] };
    cell.run = queueInline(headers[i]);
    item.header.push(cell);
  }

  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => {
      const c = { text: cell, header: false, align: item.align[i] };
      c.run = queueInline(cell);
      return c;
    }));
  }

  return item;
}

function tokLheading(src) {
  const cap = lheadingGfm.exec(src);
  if (cap) {
    const text = cap[1].trim();
    const node = { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text };
    node.run = queueInline(text);
    return node;
  }
  return null;
}

// Paragraph: line-based consumption with the same interruption rules as
// marked's paragraph regex (hr, heading, blockquote, fences, list,
// html, table, blank line). Setext underlines do NOT interrupt.
const PARA_PATTERNS = {
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}#{1,6}(?:\s|$)/,
  fences: /^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/,
  list: /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/,
  html: /^ {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/i,
  quote: /^ {0,3}>/,
};

function paraInterrupts(line, rest, nextLineHasDash) {
  // the patterns are tested against the source at the line start, so the
  // line's own trailing newline is part of the input
  const lineNl = line + '\n';
  const checks = [
    [PARA_PATTERNS.hr, lineNl],
    [PARA_PATTERNS.heading, lineNl],
    [PARA_PATTERNS.quote, line],
    [PARA_PATTERNS.fences, lineNl],
    [PARA_PATTERNS.list, line],
    [PARA_PATTERNS.html, lineNl],
  ];
  for (const [pattern, input] of checks) {
    if (pattern.test(input)) return true;
  }
  if (nextLineHasDash && gfmTable.test(rest)) return true;
  return false;
}

// Walk the lines after the first, consuming them while they belong to
// the paragraph. Returns the end index of the last consumed line.
function paragraphEnd(src, firstNl) {
  let end = firstNl; // index of the newline ending the last consumed line
  for (let pos = firstNl + 1; pos < src.length;) {
    const nl = src.indexOf('\n', pos);
    const lineEnd = nl === -1 ? src.length : nl;
    const line = src.slice(pos, lineEnd);
    // a blank line interrupts; a whitespace-only line at end of string
    // (no trailing newline) does not — marked's paragraph rule only
    // stops at `[ \t]+\n`
    if (line === '' || (nl !== -1 && !line.trim())) break;
    // table interruption needs the line after this one
    const afterNl = nl === -1 ? -1 : src.indexOf('\n', nl + 1);
    const nextLine = nl === -1 ? '' : src.slice(nl + 1, afterNl === -1 ? src.length : afterNl);
    if (paraInterrupts(line, src.slice(pos), nextLine.includes('-'))) break;
    end = lineEnd;
    pos = lineEnd + 1;
    if (nl === -1) break;
  }
  return end;
}

function tokParagraph(src) {
  // first line is consumed unconditionally
  const firstNl = src.indexOf('\n');
  if (firstNl === -1) {
    if (!src.trim()) return null;
    const node = { type: 'paragraph', raw: src, text: src };
    node.run = queueInline(src);
    return node;
  }
  const text = src.slice(0, paragraphEnd(src, firstNl));
  if (!text.trim()) return null;
  const node = { type: 'paragraph', raw: text, text };
  node.run = queueInline(text);
  return node;
}

function tokText(src) {
  const cap = blockText.exec(src);
  if (cap) {
    const node = { type: 'text', raw: cap[0], text: cap[0] };
    node.run = queueInline(cap[0]);
    return node;
  }
  return null;
}

// Does a setext underline appear before the next blank line? (gate for
// the lheading regex, which is expensive to run blindly.)
function hasSetextUnderline(src) {
  let pos = 0;
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos);
    const lineEnd = nl === -1 ? src.length : nl;
    const line = src.slice(pos, lineEnd);
    if (!line.trim()) return false;
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) return true;
    pos = lineEnd + 1;
    if (nl === -1) return false;
  }
  return false;
}

/**
 * Main block loop — port of marked's Lexer.blockTokens.
 */
// Fold a block token into the preceding paragraph/text token when the
// grammar says it continues one (indented code, link definitions, and
// clipped paragraphs/text). `kinds` limits which previous token types
// may absorb it; `popQueue` drops the absorbed run's inline queue entry
// first (paragraph and text merges re-queue the combined text).
function absorbIntoLast(tokens, token, textPiece, popQueue, kinds) {
  const last = tokens.at(-1);
  if (!last || !kinds.includes(last.type)) return false;
  last.raw += (last.raw.endsWith('\n') ? '' : '\n') + token.raw;
  last.text += '\n' + textPiece;
  if (popQueue) LX.inlineQueue.pop();
  LX.inlineQueue.at(-1).src = last.text;
  return true;
}

// Is the second line a table delimiter row (the gate for the table
// rule, which is expensive to run blindly)?
function tableDelimiterAhead(src) {
  const nl1 = src.indexOf('\n');
  if (nl1 === -1) return false;
  const nl2 = src.indexOf('\n', nl1 + 1);
  const second = src.slice(nl1 + 1, nl2 === -1 ? src.length : nl2);
  return second.includes('-');
}

// Block dispatch table, in marked's tokenizer order. Each entry has a
// gate on the first character (and, for tables and setext headings, on
// the following lines) and a run that returns how many source characters
// its token consumed, or 0 when it does not apply. `resetsClip` marks
// the paragraph entry, the only one that clears lastParagraphClipped.
const BLOCK_ATTEMPTS = [
  {
    gate: (h) => h === '\n' || h === ' ' || h === '\t',
    run: (src, tokens) => {
      const token = tokSpace(src);
      if (!token) return 0;
      if (token.raw.length === 1 && tokens.at(-1) !== undefined) {
        tokens.at(-1).raw += '\n';
      } else {
        tokens.push(token);
      }
      return token.raw.length;
    },
  },
  {
    gate: (h) => h === ' ' || h === '\t',
    run: (src, tokens) => {
      const token = tokCode(src);
      if (!token) return 0;
      const absorbed = absorbIntoLast(tokens, token, token.text, false,
        ['paragraph', 'text']);
      if (!absorbed) tokens.push(token);
      return token.raw.length;
    },
  },
  {
    gate: (h) => h === '`' || h === '~' || h === ' ' || h === '\t',
    run: (src, tokens) => {
      const token = tokFences(src);
      if (!token) return 0;
      tokens.push(token);
      return token.raw.length;
    },
  },
  {
    gate: (h) => h === '#' || h === ' ' || h === '\t',
    run: (src, tokens) => {
      const token = tokHeading(src);
      if (!token) return 0;
      tokens.push(token);
      return token.raw.length;
    },
  },
  {
    gate: (h) => h === '-' || h === '_' || h === '*' || h === ' ' || h === '\t',
    run: (src, tokens) => {
      const token = tokHr(src);
      if (!token) return 0;
      tokens.push(token);
      return token.raw.length;
    },
  },
  {
    gate: (h) => h === '>' || h === ' ' || h === '\t',
    run: (src, tokens) => {
      const token = tokBlockquote(src);
      if (!token) return 0;
      tokens.push(token);
      return token.raw.length;
    },
  },
  {
    gate: (h) => h === '*' || h === '+' || h === '-' || (h >= '0' && h <= '9')
      || h === ' ' || h === '\t',
    run: (src, tokens) => {
      const token = tokList(src);
      if (!token) return 0;
      tokens.push(token);
      return token.raw.length;
    },
  },
  {
    gate: (h) => h === '<' || h === ' ' || h === '\t',
    run: (src, tokens) => {
      const token = tokHtml(src);
      if (!token) return 0;
      tokens.push(token);
      return token.raw.length;
    },
  },
  {
    gate: (h) => h === '[' || h === ' ' || h === '\t',
    run: (src, tokens) => {
      const token = tokDef(src);
      if (!token) return 0;
      const absorbed = absorbIntoLast(tokens, token, token.raw, false,
        ['paragraph', 'text']);
      if (!absorbed) {
        if (!LX.links[token.tag]) {
          LX.links[token.tag] = { href: token.href, title: token.title };
          S.linkCount++;
        }
        tokens.push(token);
      }
      return token.raw.length;
    },
  },
  {
    gate: (_h, src) => tableDelimiterAhead(src),
    run: (src, tokens) => {
      const token = tokTable(src);
      if (!token) return 0;
      tokens.push(token);
      return token.raw.length;
    },
  },
  {
    gate: (_h, src) => hasSetextUnderline(src),
    run: (src, tokens) => {
      const token = tokLheading(src);
      if (!token) return 0;
      tokens.push(token);
      return token.raw.length;
    },
  },
  {
    gate: () => LX.top,
    resetsClip: true,
    run: (src, tokens, clipped) => {
      const token = tokParagraph(src);
      if (!token) return 0;
      const last = tokens.at(-1);
      if (clipped && last?.type === 'paragraph') {
        absorbIntoLast(tokens, token, token.text, true, ['paragraph']);
      } else {
        tokens.push(token);
      }
      return token.raw.length;
    },
  },
  {
    gate: () => true,
    run: (src, tokens) => {
      const token = tokText(src);
      if (!token) return 0;
      const absorbed = absorbIntoLast(tokens, token, token.text, true, ['text']);
      if (!absorbed) tokens.push(token);
      return token.raw.length;
    },
  },
];

/**
 * Main block loop — port of marked's Lexer.blockTokens.
 */
function blockTokens(src, tokens = [], lastParagraphClipped = false) {
  let shortest = Infinity;
  while (src) {
    if (src.length < shortest) {
      shortest = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    const head = src[0];
    let consumed = 0;
    for (const attempt of BLOCK_ATTEMPTS) {
      if (!attempt.gate(head, src)) continue;
      const n = attempt.run(src, tokens, lastParagraphClipped);
      if (!n) continue;
      consumed = n;
      if (attempt.resetsClip) lastParagraphClipped = false;
      break;
    }
    if (consumed === 0) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    src = src.substring(consumed);
  }
  LX.top = true;
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Rendering — mirrors marked's default Renderer                      */
/* ------------------------------------------------------------------ */

function renderCode(node) {
  const lang = (node.lang || '').match(other.notSpaceStart)?.[0];
  const body = node.text ? node.text.replace(other.endingNewline, '') + '\n' : '';
  const open = lang
    ? '<pre><code class="language-' + escapeHtml(lang) + '">'
    : '<pre><code>';
  return open + escapeHtml(body, true) + '</code></pre>\n';
}

function renderTableRow(cells, tagName) {
  let rowHtml = '';
  for (const c of cells) {
    const open = c.align ? `<${tagName} align="${c.align}">` : `<${tagName}>`;
    rowHtml += open + c.run.html + `</${tagName}>\n`;
  }
  return `<tr>\n${rowHtml}</tr>\n`;
}

function renderTable(node) {
  const headHtml = renderTableRow(node.header, 'th');
  let bodyHtml = '';
  for (const row of node.rows) {
    bodyHtml += renderTableRow(row, 'td');
  }
  if (bodyHtml) bodyHtml = `<tbody>${bodyHtml}</tbody>`;
  return '<table>\n<thead>\n' + headHtml + '</thead>\n' + bodyHtml + '</table>\n';
}

// One renderer per block type, looked up by token.type instead of a
// switch: unknown types still throw, exactly as marked does.
const BLOCK_RENDERERS = {
  space: () => '',
  hr: () => '<hr>\n',
  heading: (t) => `<h${t.depth}>${t.run.html}</h${t.depth}>\n`,
  code: (t) => renderCode(t),
  table: (t) => renderTable(t),
  blockquote: (t) => `<blockquote>\n${renderBlocks(t.tokens)}</blockquote>\n`,
  list: (t) => {
    let body = '';
    for (const item of t.items) {
      body += `<li>${renderBlocks(item.tokens)}</li>\n`;
    }
    const tag = t.ordered ? 'ol' : 'ul';
    const startAttr = (t.ordered && t.start !== 1) ? (' start="' + t.start + '"') : '';
    return '<' + tag + startAttr + '>\n' + body + '</' + tag + '>\n';
  },
  checkbox: (t) => '<input ' + (t.checked ? 'checked="" ' : '')
    + 'disabled="" type="checkbox"> ',
  html: (t) => t.text,
  def: () => '',
  paragraph: (t) => `<p>${t.run.html}</p>\n`,
  text: (t) => t.run.html,
};

function renderBlocks(tokens) {
  let out = '';
  for (const token of tokens) {
    const render = BLOCK_RENDERERS[token.type];
    if (!render) throw new Error('Token with "' + token.type + '" type was not found.');
    out += render(token);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

export function parse(markdown) {
  S.links = Object.create(null);
  LX.links = S.links;
  LX.inlineQueue = [];
  LX.top = true;
  S.inLink = false;
  S.inRawBlock = false;
  S.linkEmitted = false;
  S.linkParenPossible = true;
  S.linkCount = 0;

  const src = markdown.replace(other.carriageReturn, '\n');
  const tokens = blockTokens(src, [], false);

  // inline pass, in tokenization order; a raw <pre>/<code>/<kbd>/<script>
  // left open ends with the block holding it
  for (const run of LX.inlineQueue) {
    S.inRawBlock = false;
    run.html = (run.prefix || '') + inlineRun(run.src);
  }

  return renderBlocks(tokens);
}
