import { useState } from 'react';
import { ScrollView } from 'react-native';

import { TextField } from '@/components/ui/text-field';

// Placeholder Search. Wired to GET /search (FTS) once the API client lands.
export default function SearchScreen() {
  const [query, setQuery] = useState('');
  return (
    <ScrollView className="flex-1" contentContainerClassName="p-4" keyboardShouldPersistTaps="handled">
      <TextField
        placeholder="Search titles, authors, series…"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        returnKeyType="search"
      />
    </ScrollView>
  );
}
