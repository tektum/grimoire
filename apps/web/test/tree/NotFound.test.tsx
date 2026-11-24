import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import NotFoundScreen from '../../src/screens/notfound';
import '../support/dom';

describe('the not-found screen', () => {
  it('says the page is not there, or not for this person, in one text that tells nothing more', () => {
    render(<MemoryRouter><NotFoundScreen /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByText("This page doesn't exist, or you don't have access to it.")).toBeTruthy();
  });
  it('leads back to the collections', () => {
    render(<MemoryRouter><NotFoundScreen /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Go to your collections' }).getAttribute('href')).toBe('/');
  });
});
