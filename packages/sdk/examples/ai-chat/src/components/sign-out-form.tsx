export const SignOutForm = ({ onSignOut }: { onSignOut: () => void }) => {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSignOut();
      }}
      className="w-full"
    >
      <button
        className="w-full px-1 py-0.5 text-left text-red-500"
        type="submit"
      >
        Sign out
      </button>
    </form>
  );
};
