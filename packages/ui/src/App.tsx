import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { RunDetailPage } from './pages/RunDetailPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/runs/:workflowId" element={<RunDetailPage />} />
      </Routes>
    </BrowserRouter>
  );
}
