export function invocationKey(manager, callId) {
  const entry = manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.content.some(part => part.type === 'toolCall' && part.id === callId));
  if (!entry) throw new Error('The persisted Pi invocation is unavailable');
  return `${manager.getSessionId()}:${entry.id}:${callId}`;
}
