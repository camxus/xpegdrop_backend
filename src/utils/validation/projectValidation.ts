import Joi from 'joi';

export const createProjectSchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
  description: Joi.string().max(500).optional(),
  is_public: Joi.boolean().optional(),
  approved_emails: Joi.array().items(Joi.string().email()).optional(),
  file_locations: Joi.string().optional()
});

export const updateProjectSchema = Joi.object({
  name: Joi.string().min(1).max(100).optional(),
  description: Joi.string().max(500).optional(),
  is_public: Joi.boolean().optional(),
  approved_emails: Joi.array().items(Joi.string().email()).optional(),
  file_locations: Joi.string().optional()
});