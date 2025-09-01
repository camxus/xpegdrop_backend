import Joi from 'joi';

export const updateUserSchema = Joi.object({
  first_name: Joi.string().min(1).max(50).optional(),
  last_name: Joi.string().min(1).max(50).optional(),
  bio: Joi.string().max(500).optional().allow(''),
  avatar: Joi.object({
    bucket: Joi.string().required(),
    key: Joi.string().required(),
  }).optional(),
  dropbox: Joi.string().optional()
});

export const updateDropboxTokenSchema = Joi.object({
  dropbox: Joi.object({
    access_token: Joi.string().required(),
    refresh_token: Joi.string().optional(),
  }).required(),
});