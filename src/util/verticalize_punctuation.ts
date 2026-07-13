import {charHasRotatedVerticalOrientation} from './script_detection';

export const verticalizedCharacterMap = {
    '!': '︕',
    '#': '＃',
    '$': '＄',
    '%': '％',
    '&': '＆',
    '(': '︵',
    ')': '︶',
    '*': '＊',
    '+': '＋',
    ',': '︐',
    '-': '︲',
    '.': '・',
    '/': '／',
    ':': '︓',
    ';': '︔',
    '<': '︿',
    '=': '＝',
    '>': '﹀',
    '?': '︖',
    '@': '＠',
    '[': '﹇',
    '\\': '＼',
    ']': '﹈',
    '^': '＾',
    '_': '︳',
    '`': '｀',
    '{': '︷',
    '|': '―',
    '}': '︸',
    '~': '～',
    '¢': '￠',
    '£': '￡',
    '¥': '￥',
    '¦': '￤',
    '¬': '￢',
    '¯': '￣',
    '–': '︲',
    '—': '︱',
    '‘': '﹃',
    '’': '﹄',
    '“': '﹁',
    '”': '﹂',
    '…': '︙',
    '‧': '・',
    '₩': '￦',
    '、': '︑',
    '。': '︒',
    '〈': '︿',
    '〉': '﹀',
    '《': '︽',
    '》': '︾',
    '「': '﹁',
    '」': '﹂',
    '『': '﹃',
    '』': '﹄',
    '【': '︻',
    '】': '︼',
    '〔': '︹',
    '〕': '︺',
    '〖': '︗',
    '〗': '︘',
    '！': '︕',
    '（': '︵',
    '）': '︶',
    '，': '︐',
    '－': '︲',
    '．': '・',
    '：': '︓',
    '；': '︔',
    '＜': '︿',
    '＞': '﹀',
    '？': '︖',
    '［': '﹇',
    '］': '﹈',
    '＿': '︳',
    '｛': '︷',
    '｜': '―',
    '｝': '︸',
    '｟': '︵',
    '｠': '︶',
    '｡': '︒',
    '｢': '﹁',
    '｣': '﹂',
} as const;

export default function verticalizePunctuation(input: string, skipContextChecking: boolean): string {
    let output = '';

    for (let i = 0; i < input.length; i++) {
        const nextCharCode = input.charCodeAt(i + 1) || null;
        const prevCharCode = input.charCodeAt(i - 1) || null;

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const canReplacePunctuation = skipContextChecking || (
            (!nextCharCode || !charHasRotatedVerticalOrientation(nextCharCode) || verticalizedCharacterMap[input[i + 1]]) &&
            (!prevCharCode || !charHasRotatedVerticalOrientation(prevCharCode) || verticalizedCharacterMap[input[i - 1]])
        );

        if (canReplacePunctuation && verticalizedCharacterMap[input[i]]) {
            output += verticalizedCharacterMap[input[i]];
        } else {
            output += input[i];
        }
    }

    return output;
}

export function isVerticalClosePunctuation(chr: string): boolean {
    return chr === '︶' || chr === '﹈' || chr === '︸' || chr === '﹄' || chr === '﹂' || chr === '︾' ||
           chr === '︼' || chr === '︺' || chr === '︘' || chr === '﹀' || chr === '︐' || chr === '︓' ||
           chr === '︔' || chr === '｀' || chr === '￣' || chr === '︑' || chr === '︒';
}

export function isVerticalOpenPunctuation(chr: string): boolean {
    return chr === '︵' || chr === '﹇' || chr === '︷' || chr === '﹃' || chr === '﹁' || chr === '︽' ||
           chr === '︻' || chr === '︹' || chr === '︗' || chr === '︿';
}
