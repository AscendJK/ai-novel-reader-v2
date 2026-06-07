import { AppLayout } from "@/components/layout/AppLayout";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { UpdateBanner } from "@/components/common/UpdateBanner";
import { ToastContainer } from "@/components/common/Toast";

export default function App() {
  return (
    <ErrorBoundary>
      <AppLayout />
      <UpdateBanner />
      <ToastContainer />
    </ErrorBoundary>
  );
}
