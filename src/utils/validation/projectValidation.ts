import Joi from 'joi';

export const createProjectSchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
  description: Joi.string().max(500).optional(),
  file_locations: Joi.alternatives().try(
    Joi.string(),        // JSON string
    Joi.array().items(Joi.object()) // Already parsed array of objects
  ).optional()
});

export const updateProjectSchema = Joi.object({
  name: Joi.string().min(1).max(100).optional(),
  description: Joi.string().max(500).optional(),
  file_locations: Joi.alternatives().try(
    Joi.string(),
    Joi.array().items(Joi.object())
  ).optional()
});