import { act } from '@testing-library/react-native';

/**
 * Let a FlashList finish its first load inside act. FlashList marks itself loaded on an
 * animation frame after its first layout (jest runs a frame as a 0 ms timer), so a test
 * that ends, or awaits something else, before that frame sees the update land outside
 * act ("An update to ForwardRef(FlashList) ... was not wrapped in act"). Call it after
 * rendering (and laying out) a FlashList.
 */
export async function settleFlashList() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
