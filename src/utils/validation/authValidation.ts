import Joi from 'joi';

export const signUpSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  first_name: Joi.string().min(1).max(50).required(),
  last_name: Joi.string().min(1).max(50).required(),
  bio: Joi.string().max(500).optional(),
  avatar: Joi.string().optional(),
  dropbox: Joi.string().optional()
});

export const signInSchema = Joi.object({
  username: Joi.string().required(),
  password: Joi.string().required(),
});

export const forgotPasswordSchema = Joi.object({
  email: Joi.string().required(),
});

export const confirmPasswordSchema = Joi.object({
  username: Joi.string().email().required(),
  code: Joi.string().required(),
  newPassword: Joi.string().min(8).required(),
});

export const newPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  newPassword: Joi.string().min(8).required(),
});