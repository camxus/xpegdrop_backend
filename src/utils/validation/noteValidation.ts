import Joi from "joi";

// Schema for creating a note
export const createNoteSchema = Joi.object({
  project_id: Joi.string().required(),
  share_id: Joi.string().optional(),
  media_name: Joi.string().optional().allow(''),
  content: Joi.string().max(200).required(),
  timestamp: Joi.number().optional(),
  author: Joi.object({ first_name: Joi.string(), last_name: Joi.string() }).optional()
});

// Schema for updating a note
export const updateNoteSchema = Joi.object({
  content: Joi.string().max(200).optional().allow(''),
  author: Joi.object({ first_name: Joi.string(), last_name: Joi.string() }).optional()
});
