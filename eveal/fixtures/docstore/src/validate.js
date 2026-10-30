export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validate(fields) {
  if (typeof fields.title !== 'string' || !fields.title.trim()) throw new ValidationError('title must be a non-empty string');
  if (fields.title.length > 120) throw new ValidationError('title is longer than 120 characters');
  if ('tags' in fields && (!Array.isArray(fields.tags) || fields.tags.some(tag => typeof tag !== 'string')))
    throw new ValidationError('tags must be an array of strings');
  if ('priority' in fields && !(Number.isInteger(fields.priority) && fields.priority >= 0 && fields.priority <= 3))
    throw new ValidationError('priority must be an integer from 0 to 3');
}
