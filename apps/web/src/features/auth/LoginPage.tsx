import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@tm/shared';
import { useAuth } from './AuthContext';
import { ApiError } from '@/lib/api';
import { Button, Card, FieldError, Input, Label, Spinner } from '@/components/ui/primitives';

export function LoginPage() {
  const { signIn, user, loading } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    // The same schema the server validates with, so the two cannot disagree.
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  if (loading) return null;
  if (user) return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signIn(values.email, values.password);
      navigate('/', { replace: true });
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not sign in. Try again in a moment.',
      );
    }
  });

  return (
    /*
     * The hero gradient behind a glass card. This is the one screen somebody
     * sees before they are anybody, so it carries the product's face rather
     * than the plain page background.
     */
    <div className="hero-surface flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm border-white/15 bg-white/8 p-6 backdrop-blur-xl">
        <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 mb-6 text-sm text-ink-muted">Team Task Manager</p>

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              autoFocus
              aria-invalid={Boolean(errors.email)}
              {...register('email')}
            />
            <FieldError message={errors.email?.message} />
          </div>

          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.password)}
              {...register('password')}
            />
            <FieldError message={errors.password?.message} />
          </div>

          {formError ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? <Spinner /> : null}
            Sign in
          </Button>
        </form>

        <Link
          to="/forgot-password"
          className="mt-4 block text-center text-xs text-ink-muted underline-offset-2 hover:text-accent hover:underline"
        >
          Forgotten your password?
        </Link>
      </Card>
    </div>
  );
}
