import Joi from 'joi';

export const updateUserSchema = Joi.object({
  first_name: Joi.string().min(1).max(50).optional(),
  last_name: Joi.string().min(1).max(50).optional(),
  bio: Joi.string().max(500).optional().allow(''),
  avatar_url: Joi.string().uri().optional(),
  dropbox: Joi.object({
    access_token: Joi.string().optional(),
    refresh_token: Joi.string().optional(),
  }).optional(),
});

export const updateDropboxTokenSchema = Joi.object({
  dropbox: Joi.object({
    access_token: Joi.string().required(),
    refresh_token: Joi.string().optional(),
  }).required(),
});