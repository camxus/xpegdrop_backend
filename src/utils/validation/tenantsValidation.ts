import Joi from "joi";

/**
 * Update main tenant fields
 */
export const updateTenantSchema = Joi.object({
  name: Joi.string().min(1).max(150).optional(),
  description: Joi.string().max(500).optional().allow(""),
  handle: Joi.string().max(500).optional().allow(""),
  avatar: Joi.object({
    bucket: Joi.string().required(),
    key: Joi.string().required(),
  }).optional(),
});

