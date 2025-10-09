using System.ComponentModel.DataAnnotations;

namespace xedmail.Model;

public class UserProfile
{
    [Key]
    public string ClerkUserId { get; set; }
    public string DisplayName { get; set; }
    public List<Mailbox> Mailboxes { get; set; } = new ();
}