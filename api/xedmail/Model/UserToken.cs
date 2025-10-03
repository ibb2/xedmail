namespace xedmail.Model;

// Add this class to your Program.cs or create Models/UserToken.cs
public class UserToken
{
    public int Id { get; set; }
    public string UserId { get; set; } = string.Empty; // Can be email or Clerk ID later
    public string AccessToken { get; set; } = string.Empty;
    public string? RefreshToken { get; set; }
    public string Email { get; set; } = string.Empty;
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}