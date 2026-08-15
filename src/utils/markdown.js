import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

marked.setOptions({
    gfm: true,
    breaks: false
});

const allowedTags = [
    ...sanitizeHtml.defaults.allowedTags,
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'
];

export const renderMarkdown = source => sanitizeHtml(marked.parse(String(source || '')), {
    allowedTags,
    allowedAttributes: {
        a: ['href', 'title', 'target', 'rel'],
        code: ['class']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
        a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true)
    }
});
