/** Templates for new documents: original text and layouts built in code (no copied artwork). */
import { PdfDocument } from '../pdf/document';
import { addBlankPage, addTextPages, PAPER } from '../pdf/build';
import { addField } from '../pdf/ops/forms';

export interface Template { id: string; name: string; description: string; icon?: string; build: () => PdfDocument }

const text = (t: string, title: string, paper: [number, number] = PAPER.letter): PdfDocument => { const d = PdfDocument.create(); addTextPages(d, t, { title, paper }); return d; };

export const TEMPLATES: Template[] = [
  { id: 'blank', name: 'Blank', description: 'One empty Letter page', icon: 'note_add', build: () => { const d = PdfDocument.create(); addBlankPage(d); return d; } },
  { id: 'blank-a4', name: 'Blank (A4)', description: 'One empty A4 page', icon: 'note_add', build: () => { const d = PdfDocument.create(); addBlankPage(d, PAPER.a4); return d; } },
  { id: 'blank-landscape', name: 'Blank landscape', description: 'One empty Letter page, landscape', icon: 'crop_landscape', build: () => { const d = PdfDocument.create(); addBlankPage(d, [PAPER.letter[1], PAPER.letter[0]]); return d; } },
  { id: 'letter', name: 'Letter', description: 'A business letter with date, address and signature lines', icon: 'mail', build: () => text('[Your name]\n[Street address]\n[City, State ZIP]\n\n[Date]\n\n[Recipient name]\n[Company]\n[Street address]\n[City, State ZIP]\n\nDear [Name],\n\n[Opening paragraph: say why you are writing.]\n\n[Body: the details, one idea per paragraph.]\n\n[Closing: what you would like to happen next, and thanks.]\n\nSincerely,\n\n\n\n[Your name]', 'Letter') },
  { id: 'memo', name: 'Memo', description: 'A one-page memorandum', icon: 'sticky_note_2', build: () => text('# Memorandum\n\nTo: [Recipients]\nFrom: [Your name]\nDate: [Date]\nSubject: [Subject]\n\n## Summary\n\n[One paragraph: what this memo decides or asks.]\n\n## Background\n\n[The facts the reader needs.]\n\n## Recommendation\n\n- [Action 1]\n- [Action 2]\n\n## Next steps\n\n1. [Who does what, by when]\n2. [Follow-up]', 'Memo') },
  { id: 'agenda', name: 'Meeting agenda', description: 'Agenda with timed items and notes space', icon: 'event_note', build: () => text('# Meeting Agenda\n\nMeeting: [Name]\nDate and time: [Date], [Time]\nPlace: [Room or link]\nAttendees: [Names]\n\n## Items\n\n1. Welcome and purpose (5 min)\n2. Review of last meeting\'s actions (10 min)\n3. [Topic] (15 min)\n4. [Topic] (15 min)\n5. Decisions and actions (10 min)\n6. Next meeting\n\n## Notes\n\n\n\n\n\n## Actions\n\n- [ ] [Action] — [Owner] — [Due]\n- [ ] [Action] — [Owner] — [Due]', 'Meeting Agenda') },
  { id: 'invoice', name: 'Invoice', description: 'An invoice with fillable fields', icon: 'receipt_long', build: () => {
    const d = text('# Invoice\n\nFrom: [Your business]\n[Address]\n[Email · Phone]\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\nPayment terms: due within 30 days. Thank you for your business.', 'Invoice');
    const page = 0;
    const y0 = 792 - 72 - 7 * 15.4;
    const labels = ['Invoice number', 'Date', 'Bill to', 'Description', 'Amount'];
    labels.forEach((l, i) => { addField(d, { name: l, type: 'text', page, rect: [220, y0 - i * 34 - 20, 540, y0 - i * 34], tooltip: l, border: [0.6, 0.6, 0.6], multiline: l === 'Bill to' || l === 'Description' }); });
    addField(d, { name: 'Total', type: 'text', page, rect: [380, y0 - 5 * 34 - 24, 540, y0 - 5 * 34], tooltip: 'Total', border: [0.3, 0.3, 0.3], fontSize: 14 });
    addField(d, { name: 'Paid', type: 'checkbox', page, rect: [220, y0 - 6 * 34 - 20, 236, y0 - 6 * 34 - 4], tooltip: 'Paid' });
    return d;
  } },
  { id: 'form', name: 'Simple form', description: 'Name, email, choices and a signature field', icon: 'ballot', build: () => {
    const d = text('# Registration Form\n\nPlease fill in every field and sign at the bottom.\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n', 'Registration Form');
    const top = 792 - 72 - 4 * 15.4;
    const row = (i: number) => top - i * 36;
    addField(d, { name: 'Name', type: 'text', page: 0, rect: [200, row(0) - 22, 540, row(0)], tooltip: 'Full name', border: [0.6, 0.6, 0.6] });
    addField(d, { name: 'Email', type: 'text', page: 0, rect: [200, row(1) - 22, 540, row(1)], tooltip: 'Email address', border: [0.6, 0.6, 0.6] });
    addField(d, { name: 'Phone', type: 'text', page: 0, rect: [200, row(2) - 22, 540, row(2)], tooltip: 'Phone number', border: [0.6, 0.6, 0.6] });
    addField(d, { name: 'Session', type: 'combo', page: 0, rect: [200, row(3) - 22, 400, row(3)], options: ['Morning', 'Afternoon', 'Evening'], tooltip: 'Preferred session', border: [0.6, 0.6, 0.6] });
    addField(d, { name: 'Newsletter', type: 'checkbox', page: 0, rect: [200, row(4) - 18, 218, row(4)], tooltip: 'Send me the newsletter' });
    addField(d, { name: 'Size', type: 'radio', page: 0, rect: [200, row(5) - 18, 218, row(5)], exportValue: 'Small', tooltip: 'Small' });
    addField(d, { name: 'Size', type: 'radio', page: 0, rect: [260, row(5) - 18, 278, row(5)], exportValue: 'Medium', tooltip: 'Medium' });
    addField(d, { name: 'Size', type: 'radio', page: 0, rect: [320, row(5) - 18, 338, row(5)], exportValue: 'Large', tooltip: 'Large' });
    addField(d, { name: 'Comments', type: 'text', page: 0, rect: [72, row(7) - 70, 540, row(7)], multiline: true, tooltip: 'Comments', border: [0.6, 0.6, 0.6] });
    addField(d, { name: 'Signature', type: 'signature', page: 0, rect: [72, row(10) - 40, 320, row(10)], tooltip: 'Signature', border: [0.3, 0.3, 0.3] });
    addField(d, { name: 'Submit', type: 'button', page: 0, rect: [400, row(10) - 28, 540, row(10)], value: 'Submit', tooltip: 'Submit' });
    return d;
  } },
  { id: 'graph-paper', name: 'Graph paper', description: 'A quarter-inch grid', icon: 'grid_on', build: () => {
    const d = PdfDocument.create();
    const p = addBlankPage(d);
    const ops: string[] = ['0.75 G 0.3 w'];
    for (let x = 36; x <= 576; x += 18) ops.push(`${x} 36 m ${x} 756 l S`);
    for (let y = 36; y <= 756; y += 18) ops.push(`36 ${y} m 576 ${y} l S`);
    d.setPageContent(p, new TextEncoder().encode(ops.join('\n')));
    return d;
  } },
  { id: 'lined', name: 'Lined paper', description: 'Ruled lines with a margin', icon: 'notes', build: () => {
    const d = PdfDocument.create();
    const p = addBlankPage(d);
    const ops: string[] = ['0.6 0.8 0.95 RG 0.5 w'];
    for (let y = 72; y <= 720; y += 24) ops.push(`54 ${y} m 558 ${y} l S`);
    ops.push('0.95 0.6 0.6 RG 90 36 m 90 756 l S');
    d.setPageContent(p, new TextEncoder().encode(ops.join('\n')));
    return d;
  } },
];

export function templateById(id: string): Template | undefined { return TEMPLATES.find((t) => t.id === id); }
