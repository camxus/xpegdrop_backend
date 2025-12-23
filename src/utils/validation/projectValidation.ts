import Joi from 'joi';

export const createProjectSchema = Joi.object({
  tenant_id: Joi.string().optional(),
  name: Joi.string().min(1).max(100).required(),
  description: Joi.string().max(500).optional(),
  is_public: Joi.boolean().optional(),
  can_download: Joi.boolean().optional(),
  approved_emails: Joi.array()
    .items(Joi.string().email())
    .optional(),
  approved_users: Joi.array()
    .items(
      Joi.object({
        user_id: Joi.array().items(Joi.string()).required(),
      })
    )
    .optional(),
  approved_tenant_users: Joi.array()
    .items(
      Joi.object({
        user_id: Joi.string().required(),
        role: Joi.string().valid("admin", "editor", "viewer").required(),
      })
    )
    .optional(),
  file_locations: Joi.string().optional(),
  file_metadata: Joi.string().optional(),
  storage_provider: Joi.string().valid("dropbox", "b2").optional()
    .messages({
      "any.only": "storage_provider must be either 'dropbox' or 'b2'",
      "any.required": "storage_provider is required",
    }),
});

export const updateProjectSchema = Joi.object({
  tenantId: Joi.string(),
  name: Joi.string().min(1).max(100).optional(),
  description: Joi.string().max(500).optional(),
  is_public: Joi.boolean().optional(),
  can_download: Joi.boolean().optional(),
  approved_emails: Joi.array().items(Joi.string().email()).optional(),
  approved_users: Joi.array()
    .items(
      Joi.object({
        user_id: Joi.array().items(Joi.string()).required(),
      })
    )
    .optional(),
  approved_tenant_users: Joi.array()
    .items(
      Joi.object({
        user_id: Joi.string().required(),
        role: Joi.string().valid("admin", "editor", "viewer").required(),
      })
    )
    .optional(),
  file_locations: Joi.string().optional()
});