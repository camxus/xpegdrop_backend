import Joi from "joi";

// Schema for creating a note
export const createNoteSchema = Joi.object({
  project_id: Joi.string().required(),
  image_name: Joi.string().optional().allow(''),
  content: Joi.string().max(200).required(),
});

// Schema for updating a note
export const updateNoteSchema = Joi.object({
  content: Joi.string().max(200).optional().allow(''),
});
