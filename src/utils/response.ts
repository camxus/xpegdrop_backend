import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export interface ApiResponse<T = any> {
  data?: T;
  error?: string;
}

export function success<T>(data: T, statusCode = 200): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify({ data } as ApiResponse<T>),
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
    },
  };
}

export function failure(error: string, statusCode = 400): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify({ error } as ApiResponse),
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
    },
  };
}
