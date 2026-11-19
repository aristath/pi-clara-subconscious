export const PRIVATE_MARKER = 'pi-subconscious:private';
export const RETURN_TYPE = 'pi-subconscious:reflection';
export function toolResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; }
