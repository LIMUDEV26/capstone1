import { ClockLoader } from 'react-spinners';

interface ClockLoaderComponentProps {
  size?: number;
  color?: string;
  loading?: boolean;
}

/**
 * Custom Clock Loader Component
 * Uses react-spinners ClockLoader with consistent styling
 */
export default function ClockLoaderComponent({
  size = 60,
  color = '#1e3a8a', // Default navy blue matching the app theme
  loading = true,
}: ClockLoaderComponentProps) {
  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center',
      padding: '20px 0'
    }}>
      <ClockLoader
        color={color}
        loading={loading}
        size={size}
        speedMultiplier={1}
      />
    </div>
  );
}
