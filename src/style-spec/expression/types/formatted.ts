import type Color from '../../util/color';
import type ResolvedImage from '../types/resolved_image';

export class FormattedSection {
    text: string;
    image: ResolvedImage | null;
    scale: number | null;
    fontStack: string | null;
    textColor: Color | null;

    constructor(text: string, image: ResolvedImage | null, scale: number | null, fontStack: string | null, textColor: Color | null) {
        // combine characters so that diacritic marks are not separate code points
        this.text = text.normalize ? text.normalize() : text;
        this.image = image;
        this.scale = scale;
        this.fontStack = fontStack;
        this.textColor = textColor;
    }
}

export default class Formatted {
    sections: Array<FormattedSection>;

    constructor(sections: Array<FormattedSection>) {
        this.sections = sections;
    }

    static fromString(unformatted: string): Formatted {
        return new Formatted([new FormattedSection(unformatted, null, null, null, null)]);
    }

    isEmpty(): boolean {
        if (this.sections.length === 0) return true;
        return !this.sections.some(section => {
            if (section.text.length !== 0) return true;
            if (!section.image) return false;
            return section.image.hasPrimary();
        });
    }

    static factory(text: Formatted | string): Formatted {
        if (text instanceof Formatted) {
            return text;
        } else {
            return Formatted.fromString(text);
        }
    }

    toString(): string {
        if (this.sections.length === 0) return '';
        return this.sections.map(section => section.text).join('');
    }

    serialize(): Array<unknown> {
        const serialized: Array<unknown> = ["format"];
        for (const section of this.sections) {
            if (section.image) {
                const primaryId = section.image.getPrimary().id.toString();
                serialized.push(['image', primaryId]);
                continue;
            }
            serialized.push(section.text);
            const options: {
                [key: string]: unknown;
            } = {};
            if (section.fontStack) {
                options["text-font"] = ["literal", section.fontStack.split(',')];
            }
            if (section.scale) {
                options["font-scale"] = section.scale;
            }
            if (section.textColor) {
                options["text-color"] = (["rgba"] as Array<unknown>).concat(section.textColor.toNonPremultipliedRenderColor(null).toArray());
            }
            serialized.push(options);
        }
        return serialized;
    }
}
